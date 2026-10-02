import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  measurePageGeneration,
  parseFoundationOptions,
  preparePageProject,
  readBenchmarkResult,
  verifyPublishedArchive,
} from "../benchmarks/scripts/compare_adapter_foundation.mjs";

const require = createRequire(import.meta.url);
const next = require("../packages/next/dist/generate.js");
const root = new URL("../", import.meta.url);
const schemaContent = fs.readFileSync(new URL("tests/fixtures/adapter-baseline-v1.1.0/schema.generated.json", root), "utf8");
const temporary = callback => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-foundation-probe-"));
  try { return callback(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
};

test("foundation comparison validates options before downloads or process work", () => {
  assert.deepEqual(parseFoundationOptions([]), { samples: 31, warmups: 5, iterations: 10_000, bundles: false });
  assert.deepEqual(parseFoundationOptions(["--", "--samples", "3", "--warmups", "1", "--iterations", "20", "--bundles"]),
    { samples: 3, warmups: 1, iterations: 20, bundles: true });
  for (const arguments_ of [["--samples"], ["--samples", "0"], ["--warmups", "-1"], ["--iterations", "1.5"], ["--baseline", "current"], ["--skip-integrity"]]) {
    assert.throws(() => parseFoundationOptions(arguments_));
  }
});

test("published archive identity is content verified rather than a version label", () => temporary(directory => {
  const archive = path.join(directory, "archive.tgz");
  fs.writeFileSync(archive, "actual published archive bytes");
  const integrity = "sha512-" + createHash("sha512").update(fs.readFileSync(archive)).digest("base64");
  assert.equal(verifyPublishedArchive(archive, integrity), integrity);
  fs.writeFileSync(archive, "candidate bytes under the same version label");
  assert.throws(() => verifyPublishedArchive(archive, integrity), /integrity mismatch/);
  assert.throws(() => verifyPublishedArchive(archive, "sha256-not-the-published-integrity"));
}));

for (const pageCount of [10, 100, 500]) {
  test(`${pageCount}-page benchmark scans actual frontend modules and checks all six files`, () => temporary(directory => {
    const project = preparePageProject(directory, pageCount, schemaContent);
    assert.equal(fs.existsSync(project.generatedDir), false);
    const result = measurePageGeneration(next, project, pageCount, { warmups: 1, samples: 1 });
    assert.equal(result.samplesMs.length, 1);
    assert.ok(result.medianMs > 0);
    assert.equal(Object.keys(result.bytes).length, 6);
    const snapshot = next.createPagesRegistrySnapshot(project);
    assert.equal(snapshot.files.length, pageCount);
    assert.equal(snapshot.identifiers.length, pageCount);
    assert.equal(snapshot.content.match(/load: \(\) => import\(/g).length, pageCount);
    assert.equal(result.bytes["schema.generated.json"].toString(), schemaContent);
    const repeated = measurePageGeneration(next, project, pageCount, { warmups: 1, samples: 1 }, result.bytes);
    assert.deepEqual(repeated.bytes, result.bytes);
    const corrupted = { ...result.bytes, "pages.generated.ts": Buffer.from("different baseline registry") };
    assert.throws(() => measurePageGeneration(next, project, pageCount, { warmups: 1, samples: 1 }, corrupted), /differs from the published baseline/);
  }));
}

test("comparison rejects drift checks that rewrite generated files", () => temporary(directory => {
  const project = preparePageProject(directory, 1, schemaContent);
  const rewriting = { ...next, checkFluxFastProject(options) {
    const result = next.checkFluxFastProject(options);
    fs.writeFileSync(options.outputFile, "unexpected mutation");
    return result;
  } };
  assert.throws(() => measurePageGeneration(rewriting, project, 1, { warmups: 1, samples: 1 }), /--check changed/);
}));

test("comparison also rejects read-only checks that only change modification times", () => temporary(directory => {
  const project = preparePageProject(directory, 1, schemaContent);
  const touching = { ...next, checkFluxFastProject(options) {
    const result = next.checkFluxFastProject(options);
    fs.utimesSync(options.outputFile, new Date(0), new Date(0));
    return result;
  } };
  assert.throws(() => measurePageGeneration(touching, project, 1, { warmups: 1, samples: 1 }), /--check changed modification time/);
}));

test("comparison refuses missing, duplicate, or malformed machine results", () => {
  assert.deepEqual(readBenchmarkResult('log\nresult: {"ready":true}\n', "result: "), { ready: true });
  for (const stdout of ["no result", "result: {}\nresult: {}", "result: invalid-json"]) {
    assert.throws(() => readBenchmarkResult(stdout, "result: "));
  }
});

test("foundation comparison remains separate from immutable historical performance gates", () => {
  const runner = fs.readFileSync(new URL("benchmarks/scripts/compare_adapter_foundation.mjs", root), "utf8");
  assert.match(runner, /verifyPublishedArchive\(filename, record\.integrity\)/);
  assert.match(runner, /record\.version, "1\.1\.0"/);
  assert.match(runner, /\[10, 100, 500\]/);
  assert.match(runner, /candidate-baseline/);
  assert.match(runner, /collectCoreBrowserModules/);
  assert.match(runner, /evaluateInactiveComparison\(summary\.runtime\)/);
  assert.doesNotMatch(runner, /ignore-registry-errors|continue-on-error|compare_v1\.0\.1/);
  const historical = fs.readFileSync(new URL("benchmarks/scripts/compare_devtools_inactive.mjs", root), "utf8");
  assert.match(historical, /baseline must be the published v1\.0\.1 tag/);
  const bundle = fs.readFileSync(new URL("benchmarks/scripts/benchmark_bundle.mjs", root), "utf8");
  assert.match(bundle, /production-bundle-result: /);
  const scripts = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8")).scripts;
  assert.equal(scripts["benchmark:adapter-foundation"],
    "pnpm --filter @fluxfast/core run build && pnpm --filter @fluxfast/codegen run build && pnpm --filter @fluxfast/react run build && pnpm --filter @fluxfast/next run build && node benchmarks/scripts/compare_adapter_foundation.mjs");
});
