import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectCoreBrowserModules } from "./core-browser-baseline.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = path.join(repositoryRoot, "packages/core");
const require = createRequire(import.meta.url);

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", timeout: 60_000,
    shell: process.platform === "win32" && binary === "npm",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

test("preserves the entire published v1.1 browser Core module graph byte-for-byte", () => {
  const baseline = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, "tests/fixtures/core-browser-v1.1.0.json"), "utf8"
  ));
  assert.equal(baseline.package, "@fluxfast/core");
  assert.equal(baseline.version, "1.1.0");
  assert.equal(
    baseline.integrity,
    "sha512-Z52wvPMYuP/TTXo1bihsPnORVEQqRnyJ5wE9pw1fWNeLB5+lLq5aRLjgxFp8hL6fEdD7ippRns7xJB3y5u7mOA=="
  );
  assert.deepEqual(collectCoreBrowserModules(coreRoot), baseline.files);
});

test("packed Core/server resolves ESM, CommonJS, types, and blocks private deep imports", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-core-server-"));
  try {
    const consumer = path.join(temporaryRoot, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true }));
    const [pack] = JSON.parse(run("npm", [
      "pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", temporaryRoot,
    ], coreRoot));
    for (const target of [
      "dist/server/index.js", "dist/server/index.d.ts", "dist/server/headers.d.ts",
      "dist/server/types.d.ts", "dist/esm/server/index.js", "dist/esm/package.json",
    ]) {
      assert.ok(pack.files.some(file => file.path === target), `Missing packed target ${target}`);
    }
    run("npm", [
      "install", path.join(temporaryRoot, pack.filename), "--ignore-scripts", "--offline",
      "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error",
    ], consumer);

    const probe = `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import * as esm from "@fluxfast/core/server";
      const require = createRequire(import.meta.url);
      const cjs = require("@fluxfast/core/server");
      const expected = ["fetchFluxInitialPage", "removeFluxHopByHopHeaders", "selectFluxForwardHeaders"];
      assert.deepEqual(Object.keys(esm).sort(), expected);
      assert.deepEqual(Object.keys(cjs).sort(), expected);
      for (const server of [esm, cjs]) {
        const incoming = new Headers({cookie:"session=example", connection:"x-secret", "x-secret":"redact"});
        assert.equal(server.selectFluxForwardHeaders(incoming).get("cookie"), "session=example");
        assert.equal(server.removeFluxHopByHopHeaders(incoming).has("x-secret"), false);
        assert.deepEqual(await server.fetchFluxInitialPage({
          backendUrl:"http://127.0.0.1:8000", path:"/missing",
          fetch:async () => new Response(JSON.stringify({detail:"Not Found"}), {status:404}),
        }), {type:"not-found"});
      }
      const browser = await import("@fluxfast/core");
      const browserCjs = require("@fluxfast/core");
      for (const name of expected) {
        assert.equal(name in browser, false);
        assert.equal(name in browserCjs, false);
      }
      for (const specifier of ["@fluxfast/core/server/redirect", "@fluxfast/core/dist/server/index.js"]) {
        assert.throws(() => require(specifier), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
        await assert.rejects(import(specifier), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
      }
    `;
    fs.writeFileSync(path.join(consumer, "probe.mjs"), probe);
    run(process.execPath, ["probe.mjs"], consumer);

    const types = `
      import { fetchFluxInitialPage, selectFluxForwardHeaders, removeFluxHopByHopHeaders,
        type FetchFluxInitialPageOptions, type FluxDevelopmentMetadata,
        type FluxInitialPageResult, type FluxTransportProxyOptions } from "@fluxfast/core/server";
      const headers: Headers = selectFluxForwardHeaders(new Headers(), ["X-Tenant"]);
      const clean: Headers = removeFluxHopByHopHeaders(headers);
      const initial: FetchFluxInitialPageOptions = {
        backendUrl:"http://127.0.0.1:8000", path:"/rooms", headers:clean,
        fetch:globalThis.fetch, diagnostics:false, maxRedirects:20,
      };
      const proxy: FluxTransportProxyOptions = { backendUrl:initial.backendUrl, fetch:globalThis.fetch };
      const pending: Promise<FluxInitialPageResult> = fetchFluxInitialPage(initial);
      const metadata: FluxDevelopmentMetadata = { initialPath:"/rooms", initialServerTrace:{} };
      function consume(result: FluxInitialPageResult): string {
        if (result.type === "not-found") return "404";
        const development: FluxDevelopmentMetadata | undefined = result.development;
        return result.envelope.page.component;
      }
      // @ts-expect-error The generic proxy requires an explicit backend address.
      const missingBackend: FluxTransportProxyOptions = {};
      // @ts-expect-error A not-found result does not carry a page envelope.
      const notFound: FluxInitialPageResult = { type:"not-found", envelope:{} };
    `;
    for (const extension of ["cts", "mts"]) {
      fs.writeFileSync(path.join(consumer, `consumer.${extension}`), types);
    }
    run(process.execPath, [
      path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"),
      "--noEmit", "--strict", "--skipLibCheck",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
      "--lib", "ES2022,DOM,DOM.Iterable", "consumer.cts", "consumer.mts",
    ], consumer);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
