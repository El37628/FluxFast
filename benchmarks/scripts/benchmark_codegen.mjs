/** Measure the complete offline schema-to-TypeScript developer toolchain. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_BENCHMARK_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const corePackage = require("../../packages/core/package.json");
const nextPackage = require("../../packages/next/package.json");

const {
  compileFluxFastMutations,
} = require("../../packages/next/dist/mutation-compiler.js");
const {
  compileFluxFastPageRoutes,
} = require("../../packages/next/dist/route-compiler.js");
const {
  compileFluxFastResourceTypes,
} = require("../../packages/next/dist/schema-compiler.js");
const {
  parseFluxFastSchemaManifest,
} = require("../../packages/next/dist/schema-manifest.js");
const {
  generateFluxFastProject,
} = require("../../packages/next/dist/generate.js");
const { runCli } = require("../../packages/next/dist/cli/index.js");
const { renderHealthRoute } = require("../../packages/next/dist/cli/files.js");

function parseArguments(argv) {
  const arguments_ = { samples: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument !== "--samples") {
      throw new TypeError(`Unknown option: ${argument}`);
    }
    const value = Number(argv[index + 1]);
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError("--samples must be a positive integer");
    }
    arguments_.samples = value;
    index += 1;
  }
  return arguments_;
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function runPythonExporter(outputDirectory, samples) {
  const pythonPath = [
    path.join(repositoryRoot, "python", "fluxfast", "src"),
    repositoryRoot,
    process.env.PYTHONPATH,
  ].filter(Boolean).join(path.delimiter);
  const result = spawnSync(
    python,
    [
      path.join(scriptDirectory, "benchmark_codegen_export.py"),
      "--output-directory",
      outputDirectory,
      "--samples",
      String(samples),
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONPATH: pythonPath },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Python schema benchmark failed (${result.status ?? "unknown"})\n${result.stderr}`,
    );
  }
}

function prepareConsumer(projectRoot, manifestText) {
  writeFile(
    projectRoot,
    "package.json",
    `${JSON.stringify({
      private: true,
      dependencies: {
        "@fluxfast/core": corePackage.version,
        "@fluxfast/next": nextPackage.version,
        next: "16.3.3",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
    }, null, 2)}\n`,
  );
  writeFile(projectRoot, "tsconfig.json", "{}\n");
  writeFile(
    projectRoot,
    "next.config.ts",
    'import { withFluxFast } from "@fluxfast/next/next-config";\n\nexport default withFluxFast({});\n',
  );
  writeFile(
    projectRoot,
    "src/fluxfast.config.ts",
    "export const fluxConfig = {};\n",
  );
  writeFile(
    projectRoot,
    "src/app/(flux)/[[...flux]]/page.tsx",
    'import { createFluxNextPage } from "@fluxfast/next/server";\nimport { fluxConfig } from "../../../fluxfast.config";\n\nexport default createFluxNextPage(fluxConfig);\n',
  );
  writeFile(
    projectRoot,
    "src/app/%5Ffluxfast/[probe]/route.ts",
    renderHealthRoute(),
  );
  writeFile(
    projectRoot,
    "src/flux-pages/home/index.tsx",
    "export default function HomePage() { return <main>Benchmark</main>; }\n",
  );
  writeFile(
    projectRoot,
    "src/.fluxfast/schema.generated.json",
    manifestText,
  );
  generateFluxFastProject({
    pagesDir: path.join(projectRoot, "src", "flux-pages"),
    outputFile: path.join(
      projectRoot,
      "src",
      ".fluxfast",
      "pages.generated.ts",
    ),
    generatedDir: path.join(projectRoot, "src", ".fluxfast"),
    schemaFile: path.join(
      projectRoot,
      "src",
      ".fluxfast",
      "schema.generated.json",
    ),
    log: false,
  });
}

function capturedCli(args, cwd) {
  const stdout = [];
  const stderr = [];
  const status = runCli(args, {
    cwd,
    stdout: message => stdout.push(message),
    stderr: message => stderr.push(message),
  });
  return {
    status,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

function measureSamples(samples, operation, verify) {
  const baseline = operation();
  verify(baseline, baseline);
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const result = operation();
    durations.push(performance.now() - started);
    verify(result, baseline);
  }
  return durations;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.round((ordered.length - 1) * fraction),
  );
  return ordered[index];
}

function median(values) {
  return percentile(values, 0.5);
}

function latencySummary(values) {
  return `${median(values).toFixed(3)} ms median, ${percentile(values, 0.95).toFixed(3)} ms p95`;
}

function formatBytes(value) {
  return value < 1024
    ? `${value} B`
    : `${(value / 1024).toFixed(1)} KiB`;
}

function compileTypeScript(manifest) {
  return [
    compileFluxFastResourceTypes(manifest),
    compileFluxFastPageRoutes(manifest),
    compileFluxFastMutations(manifest),
  ].join("\n");
}

function benchmarkNodeWorkload(workload, root) {
  const manifestPath = path.join(root, workload.manifest_file);
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const parsed = parseFluxFastSchemaManifest(manifestText);
  assert.equal(parsed.fingerprint, workload.fingerprint);
  assert.equal(Object.keys(parsed.resources).length, workload.resources);
  assert.equal(parsed.pages.length, workload.routes);
  assert.equal(parsed.mutations.length, workload.mutations);

  const projectRoot = path.join(root, `consumer-${workload.name}`);
  prepareConsumer(projectRoot, manifestText);

  const parseMs = measureSamples(
    workload.samples,
    () => parseFluxFastSchemaManifest(manifestText),
    result => {
      assert.equal(result.fingerprint, workload.fingerprint);
      assert.equal(Object.keys(result.resources).length, workload.resources);
      assert.equal(result.pages.length, workload.routes);
      assert.equal(result.mutations.length, workload.mutations);
    },
  );

  const typeGenerationMs = measureSamples(
    workload.samples,
    () => compileTypeScript(parsed),
    (result, baseline) => {
      assert.equal(result, baseline);
      assert.match(result, new RegExp(`Fingerprint: ${workload.fingerprint}`));
    },
  );

  const doctorMs = measureSamples(
    workload.samples,
    () => capturedCli(["doctor"], projectRoot),
    result => {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Generated TypeScript is current/);
      assert.match(
        result.stdout,
        new RegExp(`${workload.resources} typed resources?`),
      );
    },
  );

  const generateCheckMs = measureSamples(
    workload.samples,
    () => capturedCli(["generate", "--check"], projectRoot),
    result => {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Generated FluxFast files are current/);
    },
  );

  return {
    ...workload,
    parseMs,
    typeGenerationMs,
    doctorMs,
    generateCheckMs,
  };
}

function printResult(result) {
  const shape = [
    `${result.resources} resources`,
    `${result.routes} routes`,
    `${result.mutations} mutations`,
  ].join(", ");
  console.log(
    `${result.name}: ${shape}; ${formatBytes(result.manifest_bytes)} manifest`,
  );
  console.log(
    `  Python schema export: ${latencySummary(result.export_ms)} (first export ${result.cold_export_ms.toFixed(3)} ms)`,
  );
  console.log(`  Node manifest parsing: ${latencySummary(result.parseMs)}`);
  console.log(
    `  TypeScript generation: ${latencySummary(result.typeGenerationMs)}`,
  );
  console.log(`  fluxfast doctor: ${latencySummary(result.doctorMs)}`);
  console.log(
    `  fluxfast generate --check: ${latencySummary(result.generateCheckMs)}`,
  );
}

function runBenchmark(samples) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "fluxfast-codegen-benchmark-"),
  );
  try {
    runPythonExporter(temporaryRoot, samples);
    const summary = JSON.parse(
      fs.readFileSync(path.join(temporaryRoot, "summary.json"), "utf8"),
    );
    assert.equal(summary.samples, samples);
    assert.equal(summary.workloads.length, 6);
    const workloads = summary.workloads.map(workload => ({
      ...workload,
      samples,
    }));
    const results = workloads.map(workload =>
      benchmarkNodeWorkload(workload, temporaryRoot)
    );

    console.log("FluxFast controlled schema-codegen benchmark");
    console.log(
      `environment: Python ${summary.python}; Node ${process.versions.node}; ${summary.platform}`,
    );
    console.log(
      `workload: ${samples} measured samples after one untimed warm-up per Node operation; no timing thresholds`,
    );
    for (const result of results) printResult(result);
    console.log(
      "tradeoff: direct parse/generation isolates codegen CPU; doctor and generate --check also include project detection, file reads, and deterministic artifact comparison",
    );
    console.log(
      "correctness: PASS — manifests stayed deterministic; handlers never executed; counts and fingerprints matched; generated output stayed byte-stable; doctor and generate --check accepted every consumer",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const { samples } = parseArguments(process.argv.slice(2));
runBenchmark(samples);
