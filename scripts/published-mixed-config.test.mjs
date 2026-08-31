import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublishedMixedPairing } from "./published-mixed-config.mjs";

test("selects current Python with the previous JavaScript packages", () => {
  assert.deepEqual(
    resolvePublishedMixedPairing({
      pairing: "python-current",
      releaseVersion: "v0.4.0",
    }),
    {
      pythonVersion: "0.4.0",
      javascriptVersion: "0.3.0",
      backendFixture: "mixed-live-backend.py",
      expectedCapabilities: "deferred-resources",
    }
  );
});

test("selects previous Python with the current JavaScript packages", () => {
  assert.deepEqual(
    resolvePublishedMixedPairing({
      pairing: "javascript-current",
      releaseVersion: "0.4.0",
      previousVersion: "v0.3.0",
    }),
    {
      pythonVersion: "0.3.0",
      javascriptVersion: "0.4.0",
      backendFixture: "mixed-legacy-backend.py",
      expectedCapabilities: "deferred-resources,live-resources",
    }
  );
});

test("rejects unknown pairings and unstable versions", () => {
  assert.throws(
    () => resolvePublishedMixedPairing({
      pairing: "both-current",
      releaseVersion: "0.4.0",
    }),
    /FLUXFAST_PAIRING/
  );
  assert.throws(
    () => resolvePublishedMixedPairing({
      pairing: "python-current",
      releaseVersion: "0.4.0-rc.1",
    }),
    /stable MAJOR\.MINOR\.PATCH/
  );
});
