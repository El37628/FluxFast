import assert from "node:assert/strict";
import test from "node:test";
import { REACT_RELEASE_PACKAGES, resolveReactPublishedConfig, waitForReactPublication } from "./react-published-config.mjs";

const config = resolveReactPublishedConfig({ version: "v1.2.0", attempts: "2" });
const ready = url => Response.json(new URL(url).hostname === "pypi.org" ? { info: { version: "1.2.0" } } : { version: "1.2.0" });

test("registry mode requests exactly the matching Python and React-host packages, never Next", () => {
  assert.deepEqual(config, { version: "1.2.0", pythonSpec: "fluxfast==1.2.0", attempts: 2,
    npmSpecs: ["@fluxfast/core@1.2.0", "@fluxfast/codegen@1.2.0", "@fluxfast/react@1.2.0", "@fluxfast/vite@1.2.0", "@fluxfast/devtools@1.2.0"] });
  assert.equal(Object.isFrozen(REACT_RELEASE_PACKAGES), true);
  assert.equal(resolveReactPublishedConfig(), undefined);
  assert.equal(resolveReactPublishedConfig({ version: "" }), undefined);
});

test("registry configuration rejects local-artifact mixing, unstable tags, and unbounded retries", () => {
  assert.throws(() => resolveReactPublishedConfig({ version: "1.2.0", artifactDirectory: "/tmp/artifacts" }), /mutually exclusive/);
  for (const version of ["1.2", "1.2.0-beta.1", "release-1.2.0"]) {
    assert.throws(() => resolveReactPublishedConfig({ version }), /stable/);
  }
  for (const attempts of ["0", "61", "2x", "1.2", "", "Infinity"]) {
    assert.throws(() => resolveReactPublishedConfig({ version: "1.2.0", attempts }), /integer from 1 to 60/);
  }
});

test("publication checks all six registries and retries only a missing version", async () => {
  const visited = [], waits = [], logs = [];
  await waitForReactPublication(config, { fetch: async (url, options) => {
    visited.push(url); assert.ok(options.signal instanceof AbortSignal);
    return url.includes("%2Freact") && visited.length <= 6 ? new Response("", { status: 404 }) : ready(url);
  }, sleep: async ms => waits.push(ms), log: message => logs.push(message) });
  assert.equal(visited.length, 12);
  assert.equal(new Set(visited).size, 6);
  assert.deepEqual(waits, [5_000]);
  assert.match(logs[0], /@fluxfast\/react/);
  assert.equal(visited.some(url => url.includes("next")), false);
});

test("publication fails closed for exhausted propagation, permissions, server errors, wrong versions, malformed data, and network failure", async () => {
  for (const status of [401, 403, 500, 503]) {
    let waits = 0;
    await assert.rejects(waitForReactPublication(config, { fetch: async () => new Response("", { status }),
      sleep: async () => waits++, log: () => {} }), /not a propagation retry/);
    assert.equal(waits, 0);
  }
  await assert.rejects(waitForReactPublication({ ...config, attempts: 1 }, {
    fetch: async () => new Response("", { status: 404 }), log: () => {},
    sleep: async () => { throw Error("must not wait"); },
  }), /did not propagate/);
  for (const data of [{ version: "1.1.0" }, {}]) {
    await assert.rejects(waitForReactPublication(config, { fetch: async () => Response.json(data),
      sleep: async () => { throw Error("must not wait"); } }), /wrong version/);
  }
  await assert.rejects(waitForReactPublication(config, { fetch: async () => new Response("invalid JSON") }), SyntaxError);
  await assert.rejects(waitForReactPublication(config, { fetch: async () => { throw Error("network unavailable"); } }), /network unavailable/);
});
