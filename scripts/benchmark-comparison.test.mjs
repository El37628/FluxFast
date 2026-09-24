import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { knownBaselineMemoryDefect, runComparison } from "../benchmarks/scripts/benchmark_v1_comparison.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("comparison benchmarks cannot silently fall back to the current checkout", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-benchmark-source-"));
  const selected = path.join(temporary, "selected-baseline-not-present");
  try {
    for (const [script, options] of [
      ["benchmark_codegen.mjs", ["--samples", "1"]],
      ["benchmark_validation.mjs", ["--samples", "1", "--iterations", "1"]],
      ["benchmark_memory.mjs", ["--samples", "1", "--cycles", "1"]],
      ["benchmark_bundle.mjs", []],
    ]) {
      const result = spawnSync(process.execPath, ["--expose-gc", path.join(root, "benchmarks/scripts", script), ...options], {
        cwd: root, encoding: "utf8", shell: false, timeout: 20_000,
        env: {
          ...process.env,
          FLUXFAST_BENCHMARK_REPOSITORY_ROOT: selected,
          FLUXFAST_BENCHMARK_PYTHON: path.join(temporary, "python-not-present"),
        },
      });
      assert.equal(result.error, undefined, `${script}: unexpected process error`);
      assert.equal(result.signal, null, `${script}: timed out rather than validating the source`);
      assert.equal(result.status, 1, `${script}: missing selected baseline was accepted`);
      assert.ok((result.stdout + result.stderr).includes(selected), `${script}: did not load the selected baseline: ${result.stdout}${result.stderr}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a known v0.9 memory failure cannot excuse unrelated benchmark failures", () => {
  const stages = ["navigation", "deferred loads", "mutation cycles", "live reconnects", "large ResourceStore", "validation calls"];
  const stdout = stages.map(name => name + ": retained +0.0 KiB").join("\n")
    + '\nlong-lived lifecycle sample 1: cycles 200; resources 16; states 600; epochs 600; heap 1 MiB'
    + '\nlong-lived lifecycle sample 2: cycles 300; resources 16; states 900; epochs 900; heap 1 MiB'
    + '\nAssertionError [ERR_ASSERTION]: assert.ok(privateSize(router.resourceStore, "stateSnapshots") <= 16)';
  const result = { status: 1, signal: null, stdout };
  assert.equal(knownBaselineMemoryDefect(result), true);
  assert.equal(knownBaselineMemoryDefect({ ...result, status: 0 }), false);
  assert.equal(knownBaselineMemoryDefect({ ...result, status: 2 }), false);
  assert.equal(knownBaselineMemoryDefect({ ...result, signal: "SIGTERM" }), false);
  assert.equal(knownBaselineMemoryDefect({ ...result, error: new Error("failed to start") }), false);
  assert.equal(knownBaselineMemoryDefect({ ...result, stdout: stdout.replace("states 900", "states 600") }), false);
  assert.equal(knownBaselineMemoryDefect({ ...result, stdout: stdout.replace("stateSnapshots", "otherState") }), false);
  assert.equal(knownBaselineMemoryDefect({ ...result, stdout: stdout + "\nTypeError: unrelated failure" }), false);
  assert.equal(knownBaselineMemoryDefect({ ...result, stdout: stdout.replace("validation calls: retained", "missing scenario") }), false);
});

test("comparison refuses to measure the candidate as its own baseline", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-benchmark-self-"));
  const output = path.join(temporary, "output");
  try {
    assert.throws(() => runComparison({ baseline: root, output, python: "not-used" }), /different checkout/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("controlled source comparison remains manual and records both workload orders", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/benchmark.yml"), "utf8");
  const runner = fs.readFileSync(path.join(root, "benchmarks/scripts/benchmark_v1_comparison.mjs"), "utf8");
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+compare_v090:/);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/m);
  assert.match(workflow, /ref: v0\.9\.0/);
  for (const manifest of [
    "package.json",
    "packages/core/package.json",
    "packages/next/package.json",
    "tests/browser/frontend/package.json",
  ]) {
    assert.ok(
      workflow.includes(`cp ${manifest} .comparison-baseline/${manifest}`),
      `comparison workflow does not align ${manifest}`,
    );
    assert.ok(
      runner.includes(`"${manifest}"`),
      `comparison runner does not allow or verify ${manifest}`,
    );
  }
  assert.equal((workflow.match(/node benchmarks\/scripts\/benchmark_v1_comparison\.mjs/g) ?? []).length, 2);
  assert.match(workflow, /--reverse/);
  assert.match(workflow, /name: v090-candidate-comparison/);
  assert.doesNotMatch(workflow, /continue-on-error|--ignore-registry-errors|\|\| true/);
});
