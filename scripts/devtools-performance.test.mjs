import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateInactiveComparison } from "../benchmarks/scripts/compare_devtools_inactive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(order, baseline, candidate) {
  return {
    order,
    baseline: { samplesMs: baseline },
    candidate: { samplesMs: candidate },
  };
}

test("inactive diagnostics gate rejects only repeatable noise-adjusted regressions", () => {
  const regression = evaluateInactiveComparison([
    run("baseline-candidate", [99.9, 100, 100.1], [102.9, 103, 103.1]),
    run("candidate-baseline", [99.9, 100, 100.1], [102.9, 103, 103.1]),
  ]);
  assert.equal(regression.blocked, true);

  const noisy = evaluateInactiveComparison([
    run("baseline-candidate", [95, 100, 105], [98, 103, 108]),
    run("candidate-baseline", [95, 100, 105], [98, 103, 108]),
  ]);
  assert.equal(noisy.blocked, false);

  const orderSensitive = evaluateInactiveComparison([
    run("baseline-candidate", [100, 100, 100], [103, 103, 103]),
    run("candidate-baseline", [100, 100, 100], [99, 99, 99]),
  ]);
  assert.equal(orderSensitive.blocked, false);
});

test("DevTools performance workflow owns all three release gates", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/devtools-performance.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /ref: v1\.0\.1/);
  assert.match(workflow, /compare_devtools_inactive\.mjs/);
  assert.match(workflow, /benchmark:devtools:memory/);
  assert.match(workflow, /benchmark:devtools:bundle/);
  assert.doesNotMatch(workflow, /continue-on-error|\|\| true/);
});

test("DevTools root export selects full development and inert production entries", () => {
  const fixture = path.join(root, "tests/browser/frontend");
  const resolve = condition => {
    const result = spawnSync(
      process.execPath,
      [`--conditions=${condition}`, "-p", 'require.resolve("@fluxfast/devtools")'],
      { cwd: fixture, encoding: "utf8", shell: false },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.match(resolve("development"), /packages[/\\]devtools[/\\]dist[/\\]index\.js$/);
  assert.match(resolve("production"), /packages[/\\]devtools[/\\]dist[/\\]disabled\.js$/);
});
