import assert from "node:assert/strict";
import test from "node:test";

import { NPM_RELEASE_PACKAGES, resolveNpmPublicationConfig, waitForNpmPublication } from "./wait-for-npm-publication.mjs";

const config = resolveNpmPublicationConfig({ version: "v1.2.0", attempts: "2" });
const ready = url => {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  return { name, versions: { "1.2.0": { name, version: "1.2.0",
    dist: { tarball: `https://registry.npmjs.org/${name}/-/package.tgz`, integrity: "sha512-test" } } } };
};

test("validates stable versions and bounded propagation attempts before network access", () => {
  assert.deepEqual(config, { version: "1.2.0", attempts: 2 });
  assert.deepEqual(resolveNpmPublicationConfig({ version: "1.2.0" }), { version: "1.2.0", attempts: 60 });
  for (const version of [undefined, "", "1.2", "1.2.0-beta.1", "release-1.2.0"]) {
    assert.throws(() => resolveNpmPublicationConfig({ version }), /stable/);
  }
  for (const attempts of ["0", "61", "2x", "1.2", "", "Infinity"]) {
    assert.throws(() => resolveNpmPublicationConfig({ version: "1.2.0", attempts }), /integer from 1 to 60/);
  }
});

test("checks every direct and transitive release package in both npm metadata formats", async () => {
  const visited = [];
  await waitForNpmPublication(config, {
    fetch: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      visited.push([decodeURIComponent(new URL(url).pathname.slice(1)), options.headers.accept]);
      // Prove we check the package index, not the independently cached version endpoint.
      assert.equal(new URL(url).pathname.split("/").length, 2);
      return Response.json(ready(url));
    }, sleep: async () => { throw Error("must not wait"); }, log: () => {},
  });
  assert.deepEqual([...new Set(visited.map(([name]) => name))],
    ["@fluxfast/core", "@fluxfast/codegen", "@fluxfast/react", "@fluxfast/vite", "@fluxfast/next", "@fluxfast/devtools"]);
  assert.equal(visited.length, 12);
  for (const name of NPM_RELEASE_PACKAGES) {
    assert.deepEqual(visited.filter(([packageName]) => packageName === `@fluxfast/${name}`).map(([, accept]) => accept),
      ["application/json", "application/vnd.npm.install-v1+json"]);
  }
});

test("DevTools being ready cannot hide any other missing release package or stale install index", async () => {
  for (const name of NPM_RELEASE_PACKAGES) {
    for (const accept of ["application/json", "application/vnd.npm.install-v1+json"]) {
      let requests = 0;
      const waits = [], logs = [];
      await waitForNpmPublication(config, {
        fetch: async (url, options) => {
          requests++;
          const data = ready(url);
          if (requests <= 12 && data.name === `@fluxfast/${name}` && options.headers.accept === accept) {
            data.versions = { "1.1.0": { version: "1.1.0" } };
          }
          return Response.json(data);
        }, sleep: async ms => waits.push(ms), log: message => logs.push(message),
      });
      assert.equal(requests, 24);
      assert.deepEqual(waits, [5_000]);
      assert.ok(logs[0].includes(`@fluxfast/${name}`));
    }
  }
});

test("retries a missing package but fails after the configured propagation bound", async () => {
  let requests = 0;
  const waits = [];
  await waitForNpmPublication(config, {
    fetch: async url => ++requests <= 12 ? new Response("", { status: 404 }) : Response.json(ready(url)),
    sleep: async ms => waits.push(ms), log: () => {},
  });
  assert.deepEqual(waits, [5_000]);
  for (const missing of [() => new Response("", { status: 404 }), url => {
    const data = ready(url); data.versions = {}; return Response.json(data);
  }]) {
    await assert.rejects(waitForNpmPublication({ ...config, attempts: 1 }, {
      fetch: async url => missing(url), log: () => {},
      sleep: async () => { throw Error("must not wait"); },
    }), /did not propagate to npm install metadata/);
  }
});

test("never retries authentication, network, HTTP, or malformed registry failures", async () => {
  const neverSleep = async () => { throw Error("must not wait"); };
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(waitForNpmPublication(config, {
      fetch: async () => new Response("", { status }), sleep: neverSleep,
    }), /not a propagation retry/);
  }
  const corruptions = [
    data => { data.name = "other"; },
    data => { delete data.versions; },
    data => { data.versions = []; },
    data => { data.versions["1.2.0"] = null; },
    data => { data.versions["1.2.0"].version = "1.1.0"; },
    data => { data.versions["1.2.0"].name = "other"; },
    data => { delete data.versions["1.2.0"].dist; },
  ];
  for (const corrupt of corruptions) {
    await assert.rejects(waitForNpmPublication(config, {
      fetch: async url => { const data = ready(url); corrupt(data); return Response.json(data); },
      sleep: neverSleep,
    }), /wrong package|malformed|wrong version/);
  }
  await assert.rejects(waitForNpmPublication(config, {
    fetch: async () => new Response("invalid JSON"), sleep: neverSleep,
  }), SyntaxError);
  await assert.rejects(waitForNpmPublication(config, {
    fetch: async () => { throw Error("network unavailable"); }, sleep: neverSleep,
  }), /network unavailable/);
});
