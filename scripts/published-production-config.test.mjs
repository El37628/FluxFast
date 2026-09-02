import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublishedProductionConfig } from "./published-production-config.mjs";

test("disables registry mode when no published version is configured", () => {
  assert.equal(resolvePublishedProductionConfig(), undefined);
  assert.equal(resolvePublishedProductionConfig({ version: "" }), undefined);
});

test("resolves registry package specifications from a release tag", () => {
  assert.deepEqual(resolvePublishedProductionConfig({ version: "v0.7.0" }), {
    version: "0.7.0",
    pythonSpec: "fluxfast==0.7.0",
    coreSpec: "@fluxfast/core@0.7.0",
    nextSpec: "@fluxfast/next@0.7.0",
    retryPython: true,
    retryJavaScript: true,
  });
});

test("accepts local artifact overrides without registry retries", () => {
  assert.deepEqual(
    resolvePublishedProductionConfig({
      version: "0.7.0",
      pythonSpec: "/tmp/fluxfast-0.7.0.whl",
      coreSpec: "/tmp/fluxfast-core-0.7.0.tgz",
      nextSpec: "/tmp/fluxfast-next-0.7.0.tgz",
    }),
    {
      version: "0.7.0",
      pythonSpec: "/tmp/fluxfast-0.7.0.whl",
      coreSpec: "/tmp/fluxfast-core-0.7.0.tgz",
      nextSpec: "/tmp/fluxfast-next-0.7.0.tgz",
      retryPython: false,
      retryJavaScript: false,
    }
  );
});

test("keeps JavaScript retries when either package still comes from npm", () => {
  assert.equal(
    resolvePublishedProductionConfig({
      version: "0.7.0",
      coreSpec: "/tmp/fluxfast-core-0.7.0.tgz",
    }).retryJavaScript,
    true
  );
});

test("rejects versions that cannot identify stable release packages", () => {
  for (const version of ["0.7", "0.7.0-rc.1", "release-0.7.0"]) {
    assert.throws(
      () => resolvePublishedProductionConfig({ version }),
      /stable MAJOR\.MINOR\.PATCH/
    );
  }
});
