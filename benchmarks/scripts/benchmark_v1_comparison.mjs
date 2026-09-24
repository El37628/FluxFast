/** Run sequential, same-harness v0.9/candidate comparisons; never gate CI on timing. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../..");
const digest = value => createHash("sha256").update(value).digest("hex");

export function knownBaselineMemoryDefect(result) {
  if (result.status !== 1 || result.signal || result.error) return false;
  const output = result.stdout ?? "";
  const stages = ["navigation", "deferred loads", "mutation cycles", "live reconnects", "large ResourceStore", "validation calls"];
  if (!stages.every(name => output.includes(name + ": retained "))) return false;
  const states = [...output.matchAll(/long-lived lifecycle sample \d+: cycles \d+; resources \d+; states (\d+);/g)].map(match => Number(match[1]));
  return states.length >= 2 && states[0] > 16 && states.every((value, index) => index === 0 || value > states[index - 1])
    && /AssertionError/.test(output) && /stateSnapshots.*<= 16/.test(output)
    && !/TypeError|MODULE_NOT_FOUND|ENOENT/.test(output);
}

function invoke(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repository, encoding: "utf8", shell: false,
    timeout: 20 * 60_000, maxBuffer: 40 * 1024 * 1024, ...options,
  });
}

function checked(command, args, options) {
  const result = invoke(command, args, options);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, (result.stdout ?? "") + (result.stderr ?? ""));
  return result.stdout.trim();
}

function sourceDigest(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "__pycache__") visit(target);
      else if (entry.isFile() && /\.(?:py|ts|tsx)$/.test(entry.name)) entries.push([path.relative(root, target), digest(fs.readFileSync(target))]);
    }
  }
  for (const owner of ["python/fluxfast/src", "packages/core/src", "packages/next/src"]) visit(path.join(root, owner));
  return digest(JSON.stringify(entries));
}

export function runComparison({ baseline, output, python, reverse = false }) {
  baseline = fs.realpathSync(path.resolve(baseline));
  output = path.resolve(output);
  assert.notEqual(baseline, fs.realpathSync(repository), "baseline must be a different checkout");
  const baselineCommit = checked("git", ["-C", baseline, "rev-parse", "HEAD"]);
  assert.equal(baselineCommit, checked("git", ["rev-parse", "v0.9.0^{}"]), "baseline must be the existing v0.9.0 tag");
  const allowed = new Set(["pnpm-lock.yaml", "packages/next/package.json", "tests/browser/frontend/package.json"]);
  const baselineChanges = checked("git", ["-C", baseline, "diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  assert.ok(baselineChanges.every(name => allowed.has(name)), "baseline runtime sources must not be modified");
  assert.equal(checked("git", ["-C", baseline, "ls-files", "--others", "--exclude-standard"]), "", "baseline must not contain additional untracked inputs");
  for (const name of ["pnpm-lock.yaml", "package.json", "packages/core/package.json", "packages/next/package.json", "tests/browser/frontend/package.json"]) {
    assert.equal(digest(fs.readFileSync(path.join(baseline, name))), digest(fs.readFileSync(path.join(repository, name))), name + ": comparison tooling must match");
  }
  fs.mkdirSync(output); // Reject an existing output directory; never overwrite prior evidence.
  const roots = [["v0.9.0", baseline], ["candidate", repository]];
  if (reverse) roots.reverse();
  const summary = {
    completed: false, startedAt: new Date().toISOString(),
    host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, startLoad: os.loadavg() },
    baselineCommit, candidateCommit: checked("git", ["rev-parse", "HEAD"]),
    node: process.versions.node, python, order: roots.map(([label]) => label),
    lockSha256: digest(fs.readFileSync(path.join(repository, "pnpm-lock.yaml"))),
    baselineToolingChanges: baselineChanges, sources: {}, harness: {}, results: [],
    policy: "Timings and heap trends are observations; investigate repeatable meaningful hot-path regressions over 10%. Candidate correctness is mandatory.",
  };
  for (const directory of ["scripts", "fixtures"]) {
    for (const name of fs.readdirSync(path.join(repository, "benchmarks", directory)).filter(name => /\.(?:py|mjs)$/.test(name)).sort()) {
      const relative = "benchmarks/" + directory + "/" + name;
      summary.harness[relative] = digest(fs.readFileSync(path.join(repository, relative)));
    }
  }
  const environments = new Map();
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const [label, root] of roots) {
    const env = {
      ...process.env,
      FLUXFAST_BENCHMARK_REPOSITORY_ROOT: root,
      FLUXFAST_BENCHMARK_PYTHON: python,
      PYTHONPATH: [path.join(root, "python/fluxfast/src"), repository].join(path.delimiter),
    };
    const versions = JSON.parse(checked(python, ["-c",
      'import fluxfast,json,platform; from importlib.metadata import version; print(json.dumps({"python":platform.python_version(),"source":fluxfast.__file__,"dependencies":{name:version(name) for name in ["fastapi","pydantic","starlette","uvicorn","anyio","httpx2","redis"]}}))',
    ], { cwd: root, env }));
    assert.ok(path.resolve(versions.source).startsWith(path.join(root, "python/fluxfast/src") + path.sep), "Python imported the wrong checkout");
    const javascript = JSON.parse(checked(process.execPath, ["-e",
      'const fs=require("node:fs");const names=["next","react","react-dom"];console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,JSON.parse(fs.readFileSync("tests/browser/frontend/node_modules/"+n+"/package.json","utf8")).version]))));',
    ], { cwd: root }));
    summary.sources[label] = { root, runtimeSha256: sourceDigest(root), python: versions, javascript };
    environments.set(label, env);
    for (const owner of ["@fluxfast/core", "@fluxfast/next"]) {
      console.log("prepare " + label + ": build " + owner);
      const result = invoke(pnpm, ["--filter", owner, "run", "build"], { cwd: root, env });
      fs.writeFileSync(path.join(output, label + "-prepare-" + owner.split("/")[1] + ".txt"), (result.stdout ?? "") + (result.stderr ?? ""));
      assert.equal(result.status, 0, "package build failed for " + label);
    }
  }
  const stable = summary.sources["v0.9.0"];
  const candidate = summary.sources.candidate;
  assert.deepEqual(stable.python.dependencies, candidate.python.dependencies);
  assert.equal(stable.python.python, candidate.python.python);
  assert.deepEqual(stable.javascript, candidate.javascript);
  const workloads = [
    ["cross-page", python, ["benchmark_cross_page.py", "--samples", "25"]],
    ["deferred", python, ["benchmark_deferred.py", "--samples", "5"]],
    ["live", python, ["benchmark_live.py", "--samples", "50"]],
    ["redis-cache", python, ["benchmark_redis_cache.py", "--samples", "10", "--warm-requests", "64"]],
    ["codegen", process.execPath, ["benchmark_codegen.mjs", "--samples", "5"]],
    ["validation", process.execPath, ["benchmark_validation.mjs", "--samples", "10", "--iterations", "100"]],
    ["memory", process.execPath, ["--expose-gc", "benchmark_memory.mjs", "--samples", "5", "--cycles", "100"]],
    ["bundle", process.execPath, ["benchmark_bundle.mjs"]],
    ["production", python, ["benchmark_production.py", "--samples", "3"]],
  ];
  const writeSummary = () => fs.writeFileSync(path.join(output, "comparison.json"), JSON.stringify(summary, null, 2) + "\n");
  writeSummary();
  for (const [name, command, arguments_] of workloads) {
    for (const [label, root] of roots) {
      console.log("start " + label + ": " + name);
      const args = arguments_.map(value => /^benchmark_/.test(value) ? path.join(repository, "benchmarks/scripts", value) : value);
      const result = invoke(command, args, { cwd: root, env: environments.get(label) });
      const text = (result.stdout ?? "") + (result.stderr ?? "");
      const filename = label + "-" + name + ".txt";
      fs.writeFileSync(path.join(output, filename), text);
      const knownDefect = label === "v0.9.0" && name === "memory" && knownBaselineMemoryDefect({ ...result, stdout: text });
      const passed = !result.error && !result.signal && result.status === 0 && /correctness: PASS/.test(text);
      summary.results.push({ label, workload: name, filename, sha256: digest(text), exitCode: result.status, signal: result.signal, status: passed ? "passed" : knownDefect ? "known-v090-state-only-memory-defect" : "failed" });
      writeSummary();
      assert.ok(passed || knownDefect, label + " " + name + " failed; inspect " + path.join(output, filename));
      console.log("finish " + label + ": " + name + " — " + summary.results.at(-1).status);
    }
  }
  for (const [label, root] of roots) assert.equal(sourceDigest(root), summary.sources[label].runtimeSha256, label + ": runtime sources changed during measurement");
  for (const [relative, hash] of Object.entries(summary.harness)) assert.equal(digest(fs.readFileSync(path.join(repository, relative))), hash, "benchmark harness changed during measurement");
  summary.completed = true;
  summary.finishedAt = new Date().toISOString();
  summary.host.finishLoad = os.loadavg();
  writeSummary();
  console.log("comparison complete: " + output);
}

function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--reverse") { options.reverse = true; continue; }
    assert.ok(["--baseline", "--output", "--python"].includes(option), "unknown option " + option);
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith("--"), option + " needs a value");
    options[option.slice(2)] = argv[++index];
  }
  assert.ok(options.baseline && options.output, "--baseline and --output are required");
  const localPython = path.join(repository, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  options.python ??= fs.existsSync(localPython) ? localPython : "python";
  runComparison(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) main(process.argv.slice(2));
