/** Compare extraction correctness and cost against integrity-pinned published v1.1.0. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { collectCoreBrowserModules } from "../../scripts/core-browser-baseline.mjs";
import { evaluateInactiveComparison } from "./compare_devtools_inactive.mjs";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../..");
const artifactNames = ["mutations.generated.ts", "pages.generated.ts", "routes.generated.ts",
  "schema.generated.json", "types.generated.ts", "validators.generated.ts"];
const orders = [["baseline-candidate", ["baseline", "candidate"]],
  ["candidate-baseline", ["candidate", "baseline"]]];

function run(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false,
    timeout: 10 * 60_000, maxBuffer: 40 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", npm_config_update_notifier: "false", ...environment } });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export function parseFoundationOptions(argv) {
  const options = { samples: 31, warmups: 5, iterations: 10_000, bundles: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--") continue;
    if (option === "--bundles") { options.bundles = true; continue; }
    assert.ok(["--samples", "--warmups", "--iterations"].includes(option), `unknown option ${option}`);
    const value = Number(argv[++index]);
    assert.ok(Number.isSafeInteger(value) && value > 0, `${option} must be a positive integer`);
    options[option.slice(2)] = value;
  }
  return options;
}

export function verifyPublishedArchive(filename, integrity) {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const actual = "sha512-" + createHash("sha512").update(fs.readFileSync(filename)).digest("base64");
  assert.equal(actual, integrity, `published archive integrity mismatch: ${filename}`);
  return actual;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function measurement(samplesMs) {
  assert.ok(samplesMs.length > 0 && samplesMs.every(value => Number.isFinite(value) && value > 0));
  const medianMs = median(samplesMs);
  return { samplesMs, medianMs, madPercent: median(samplesMs.map(value => Math.abs(value - medianMs))) / medianMs * 100 };
}

function snapshot(directory) {
  assert.deepEqual(fs.readdirSync(directory).sort(), artifactNames);
  return Object.fromEntries(artifactNames.map(name => [name, {
    content: fs.readFileSync(path.join(directory, name)), mtime: fs.statSync(path.join(directory, name)).mtimeMs,
  }]));
}

export function preparePageProject(root, pageCount, schemaContent) {
  assert.ok(Number.isSafeInteger(pageCount) && pageCount > 0);
  const pagesDir = path.join(root, "src/flux-pages");
  const generatedDir = path.join(root, "src/.fluxfast");
  for (let index = 0; index < pageCount; index++) {
    const source = path.join(pagesDir, `page-${String(index).padStart(4, "0")}`, "index.tsx");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `export default function Page${index}() { return null; }\n`);
  }
  return { pagesDir, generatedDir, outputFile: path.join(generatedDir, "pages.generated.ts"), schemaContent, log: false };
}

export function measurePageGeneration(api, project, pageCount, options, expected) {
  const samplesMs = [];
  let bytes = expected;
  for (let index = -options.warmups; index < options.samples; index++) {
    const started = performance.now();
    const result = api.generateFluxFastProject(project);
    const elapsed = performance.now() - started;
    if (index >= 0) samplesMs.push(elapsed);
    // Scanning, generation, and atomic writes are timed; assertions are not.
    assert.equal(api.createPagesRegistrySnapshot(project).identifiers.length, pageCount);
    assert.equal(result.generatedFiles.length, 5);
    const current = Object.fromEntries(Object.entries(snapshot(project.generatedDir)).map(([name, value]) => [name, value.content]));
    if (bytes) {
      assert.deepEqual(Object.keys(bytes).sort(), artifactNames);
      for (const name of artifactNames) {
        // Avoid rendering whole generated Buffer graphs on a failure: Node's
        // deep-diff formatting is needlessly expensive for hundreds of pages.
        assert.equal(current[name].equals(bytes[name]), true,
          `generation differs from the published baseline: ${name}`);
      }
    }
    bytes ??= current;
    const before = snapshot(project.generatedDir);
    assert.equal(api.checkFluxFastProject(project).current, true);
    const after = snapshot(project.generatedDir);
    for (const name of artifactNames) {
      assert.equal(after[name].content.equals(before[name].content), true, `--check changed output content: ${name}`);
      assert.equal(after[name].mtime, before[name].mtime, `--check changed modification time: ${name}`);
    }
  }
  return { ...measurement(samplesMs), bytes };
}

export function readBenchmarkResult(stdout, prefix) {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  assert.equal(lines.length, 1, `expected exactly one ${prefix} result`);
  return JSON.parse(lines[0].slice(prefix.length));
}

function assertOwnedPackage(root, name) {
  const installed = fs.realpathSync(path.join(root, "node_modules", name));
  assert.ok(installed.startsWith(root + path.sep), `${name} resolved outside its isolated consumer`);
  return installed;
}

function prepareConsumers(temporary, options, facts) {
  const archiveRoot = path.join(temporary, "archives");
  const publishedRoot = path.join(archiveRoot, "published");
  const candidateRoot = path.join(archiveRoot, "candidate");
  fs.mkdirSync(publishedRoot, { recursive: true });
  fs.mkdirSync(candidateRoot);
  const published = facts.publishedPackages.map(record => {
    assert.equal(record.version, "1.1.0");
    const [packed] = JSON.parse(run("npm", ["pack", `${record.name}@${record.version}`, "--ignore-scripts", "--json", "--pack-destination", publishedRoot], repository));
    const filename = path.join(publishedRoot, packed.filename);
    verifyPublishedArchive(filename, record.integrity);
    return filename;
  });
  assert.deepEqual(facts.publishedPackages.map(record => record.name).sort(), ["@fluxfast/core", "@fluxfast/next"]);
  const candidate = ["core", "codegen", "react", "next"].map(name => {
    const [packed] = JSON.parse(run("npm", ["pack", `./packages/${name}`, "--ignore-scripts", "--json", "--pack-destination", candidateRoot], repository));
    return path.join(candidateRoot, packed.filename);
  });
  const fixture = JSON.parse(fs.readFileSync(path.join(repository, "tests/release-consumer/javascript/package.json"), "utf8"));
  const tooling = options.bundles ? Object.entries({ ...fixture.dependencies, ...fixture.devDependencies }).map(([name, version]) => `${name}@${version}`) : [];
  const roots = {};
  for (const [label, archives] of [["baseline", published], ["candidate", candidate]]) {
    const root = path.join(temporary, label);
    roots[label] = root;
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"private":true}\n');
    // A real lockfile is also Turbopack's boundary for the generated apps.
    run("npm", ["install", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", ...tooling, ...archives], root);
    fs.mkdirSync(path.join(root, "packages"));
    for (const name of label === "baseline" ? ["core", "next"] : ["core", "codegen", "react", "next"]) {
      const installed = assertOwnedPackage(root, `@fluxfast/${name}`);
      fs.symlinkSync(installed, path.join(root, "packages", name), "dir");
    }
    if (options.bundles) {
      for (const [name, version] of Object.entries({ ...fixture.dependencies, ...fixture.devDependencies })) {
        assert.equal(JSON.parse(fs.readFileSync(path.join(assertOwnedPackage(root, name), "package.json"), "utf8")).version, version);
      }
      const frontend = path.join(root, "tests/browser/frontend");
      fs.mkdirSync(frontend, { recursive: true });
      fs.symlinkSync(path.join(root, "node_modules"), path.join(frontend, "node_modules"), "dir");
    }
  }
  assert.deepEqual(collectCoreBrowserModules(assertOwnedPackage(roots.candidate, "@fluxfast/core")),
    collectCoreBrowserModules(assertOwnedPackage(roots.baseline, "@fluxfast/core")), "browser Core changed or reached server/framework modules");
  return { roots, tooling, candidateArchives: candidate.map(filename => ({ filename,
    sha512: createHash("sha512").update(fs.readFileSync(filename)).digest("base64") })) };
}

export function runFoundationComparison(options) {
  const facts = JSON.parse(fs.readFileSync(path.join(repository, "tests/fixtures/adapter-baseline-v1.1.0/baseline.json"), "utf8"));
  const schemaContent = fs.readFileSync(path.join(repository, "tests/fixtures/adapter-baseline-v1.1.0/schema.generated.json"), "utf8");
  assert.equal(createHash("sha256").update(schemaContent).digest("hex"), facts.artifactDigests["schema.generated.json"]);
  const resultRoot = path.join(repository, "benchmark-results");
  fs.mkdirSync(resultRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(resultRoot, "adapter-foundation-"));
  console.log(`Owned published/candidate consumers and full results: ${temporary}`);
  const { roots, tooling, candidateArchives } = prepareConsumers(temporary, options, facts);
  const summary = { baseline: facts.publishedPackages, candidateCommit: run("git", ["rev-parse", "HEAD"], repository).trim(),
    candidateWorktree: run("git", ["status", "--porcelain=v1"], repository).trim(), candidateArchives, tooling,
    node: process.versions.node, host: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length },
    options, workload: "10/100/500 scanned frontend page modules; fixed published v1.1 typed manifest; full six-artifact generation with atomic writes; assertions outside timing", generation: [], runtime: [], bundles: [] };
  const apis = Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, createRequire(path.join(root, "package.json"))("@fluxfast/next/generate")]));
  for (const pageCount of [10, 100, 500]) {
    let expected;
    for (const [order, labels] of orders) {
      const results = {};
      for (const label of labels) {
        const project = preparePageProject(path.join(temporary, `${pageCount}-${order}-${label}`), pageCount, schemaContent);
        const { bytes, ...result } = measurePageGeneration(apis[label], project, pageCount, options, expected);
        expected ??= bytes;
        results[label] = result;
      }
      const differencePercent = (results.candidate.medianMs / results.baseline.medianMs - 1) * 100;
      summary.generation.push({ pageCount, order, differencePercent, ...results });
      console.log(`${pageCount} pages ${order}: baseline ${results.baseline.medianMs.toFixed(3)} ms; candidate ${results.candidate.medianMs.toFixed(3)} ms; difference ${differencePercent.toFixed(3)}%`);
    }
  }
  for (const [order, labels] of orders) {
    const results = {};
    for (const label of labels) {
      const stdout = run(process.execPath, [path.join(repository, "benchmarks/scripts/benchmark_devtools_inactive.mjs"), "--samples", String(options.samples), "--iterations", String(options.iterations)], repository,
        { FLUXFAST_BENCHMARK_REPOSITORY_ROOT: roots[label] });
      fs.writeFileSync(path.join(temporary, `${order}-${label}-runtime.log`), stdout);
      results[label] = readBenchmarkResult(stdout, "inactive-diagnostics-result: ");
      assert.equal(results[label].samples, options.samples);
      assert.equal(results[label].iterations, options.iterations);
      assert.equal(results[label].samplesMs.length, options.samples);
      assert.equal(path.resolve(results[label].repositoryRoot), roots[label], "runtime measured a different package source");
      measurement(results[label].samplesMs);
    }
    summary.runtime.push({ order, ...results });
  }
  summary.runtimeEvaluation = evaluateInactiveComparison(summary.runtime);
  for (const result of summary.runtimeEvaluation.comparisons) console.log(`runtime ${result.order}: difference ${result.regressionPercent.toFixed(3)}%; MAD noise ${result.noisePercent.toFixed(3)}%`);
  if (options.bundles) {
    for (const [order, labels] of orders) {
      const results = {};
      for (const label of labels) {
        const stdout = run(process.execPath, [path.join(repository, "benchmarks/scripts/benchmark_bundle.mjs")], repository,
          { FLUXFAST_BENCHMARK_REPOSITORY_ROOT: roots[label] });
        fs.writeFileSync(path.join(temporary, `${order}-${label}-bundle.log`), stdout);
        results[label] = readBenchmarkResult(stdout, "production-bundle-result: ");
      }
      assert.equal(results.baseline.next, results.candidate.next);
      assert.equal(results.baseline.results.length, 5);
      assert.equal(results.candidate.results.length, 5);
      const differences = results.baseline.results.map((baseline, index) => {
        const candidate = results.candidate.results[index];
        for (const name of ["name", "retained", "retainedRuntimeMarkers"]) assert.deepEqual(candidate[name], baseline[name]);
        return { name: baseline.name, firstLoadDeltaBytes: candidate.firstLoadBytes - baseline.firstLoadBytes,
          totalChunkDeltaBytes: candidate.totalChunkBytes - baseline.totalChunkBytes };
      });
      summary.bundles.push({ order, ...results, differences });
      console.log(`bundle ${order}: ${JSON.stringify(differences)}`);
    }
  }
  // Retain failures as well as successes; never change the v1.0.1 CI policy.
  fs.writeFileSync(path.join(temporary, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  assert.equal(summary.runtimeEvaluation.blocked, false, "repeatable noise-adjusted runtime regression against published v1.1.0");
  console.log("PASS: published integrity, isolated packages, browser graph separation, all six artifact bytes, read-only checks, and runtime convergence. Generation timings and bundle deltas are observations, not relaxed historical CI gates.");
  return { temporary, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) runFoundationComparison(parseFoundationOptions(process.argv.slice(2)));
