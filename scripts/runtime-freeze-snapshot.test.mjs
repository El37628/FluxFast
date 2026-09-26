import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../tests/fixtures/runtime-v1.0-candidate.json", import.meta.url),
    "utf8"
  )
);

function auditFacts() {
  const source = fs.readFileSync(
    new URL("../docs/releases/v1.0-final-freeze-audit.md", import.meta.url),
    "utf8"
  );
  const section = source
    .split("<!-- v1-freeze-audit-facts:start -->", 2)[1]
    ?.split("<!-- v1-freeze-audit-facts:end -->", 1)[0];
  assert.notEqual(section, undefined, "missing final freeze-audit fact markers");
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, "missing final freeze-audit JSON facts");
  return JSON.parse(block[1]);
}

test("retains the exact runtime snapshot audited for v1.0.0", () => {
  assert.equal(fixture.baseline, "v0.9.0");
  assert.equal(fixture.auditedCommit, "a5ea091b6ce8679d1321716400aa2c792fbc5f42");
  assert.deepEqual(fixture.runtime, {
    sourceRoots: [
      "packages/core/src",
      "packages/next/src",
      "python/fluxfast/src/fluxfast",
    ],
    versionNormalizedPaths: [
      "python/fluxfast/src/fluxfast/__init__.py",
    ],
    runtimeFileCount: 100,
    runtimeDigest: "cb839991228a6ca12b5341b1c63d0602ed5b559250708f31cbbcd5eb0bc3d762",
  });
});

test("records a passing final audit with no unresolved release blocker", () => {
  assert.deepEqual(auditFacts(), {
    baseline: fixture.baseline,
    auditedCommit: fixture.auditedCommit,
    runtimeSnapshot: "tests/fixtures/runtime-v1.0-candidate.json",
    unresolved: { P0: 0, P1: 0 },
    decision: "pass",
  });
});
