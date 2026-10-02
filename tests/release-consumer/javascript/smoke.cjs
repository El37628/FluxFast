const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("@fluxfast/core");
const coreServer = require("@fluxfast/core/server");
const codegen = require("@fluxfast/codegen");
const nextAdapter = require("@fluxfast/next");
const nextClient = require("@fluxfast/next/client");
const nextGenerate = require("@fluxfast/next/generate");
const nextServer = require("@fluxfast/next/server");
const nextConfig = require("@fluxfast/next/next-config");
const devtools = require("@fluxfast/devtools");

async function main() {
  const installedRoot = path.join(process.cwd(), "node_modules");
  const coreEntry = require.resolve("@fluxfast/core");
  const nextEntry = require.resolve("@fluxfast/next");
  const devtoolsEntry = require.resolve("@fluxfast/devtools");

  assert.equal(coreEntry.startsWith(installedRoot), true);
  assert.equal(nextEntry.startsWith(installedRoot), true);
  assert.equal(devtoolsEntry.startsWith(installedRoot), true);
  for (const entry of ["@fluxfast/core/server", "@fluxfast/codegen"]) {
    assert.equal(fs.realpathSync(require.resolve(entry)).startsWith(installedRoot + path.sep), true);
  }
  assert.equal(typeof core.createFluxRuntime, "function");
  assert.equal(typeof nextAdapter.defineFluxConfig, "function");
  assert.equal(typeof nextClient.useForm, "function");
  assert.equal(typeof nextClient.useLiveStatus, "function");
  assert.equal(typeof nextGenerate.generateFluxFastProject, "function");
  assert.equal(typeof nextServer.createFluxNextPage, "function");
  assert.equal(typeof nextConfig.withFluxFast, "function");
  assert.equal(typeof devtools.FluxDevtools, "function");
  const [
    coreEsm,
    coreServerEsm,
    codegenEsm,
    nextEsm,
    nextClientEsm,
    nextServerEsm,
    nextGenerateEsm,
    nextConfigEsm,
    devtoolsEsm,
  ] = await Promise.all([
    import("@fluxfast/core"),
    import("@fluxfast/core/server"),
    import("@fluxfast/codegen"),
    import("@fluxfast/next"),
    import("@fluxfast/next/client"),
    import("@fluxfast/next/server"),
    import("@fluxfast/next/generate"),
    import("@fluxfast/next/next-config"),
    import("@fluxfast/devtools"),
  ]);
  assert.equal(typeof coreEsm.createValidator, "function");
  for (const server of [coreServer, coreServerEsm]) {
    assert.equal(typeof server.fetchFluxInitialPage, "function");
    assert.equal(typeof server.createFluxTransportProxy, "function");
    const forwarded = server.selectFluxForwardHeaders({ cookie: "session=test", host: "private.invalid" });
    assert.equal(forwarded.get("cookie"), "session=test");
    assert.equal(forwarded.has("host"), false);
    assert.equal(server.removeFluxHopByHopHeaders({ connection: "x-private", "x-private": "hidden" }).has("x-private"), false);
  }
  assert.equal(typeof nextEsm.useForm, "function");
  assert.equal(typeof nextClientEsm.useForm, "function");
  assert.equal(typeof nextClientEsm.useLiveStatus, "function");
  assert.equal(typeof nextServerEsm.createFluxNextPage, "function");
  assert.equal(typeof nextGenerateEsm.generateFluxFastProject, "function");
  assert.equal(typeof nextConfigEsm.withFluxFast, "function");
  assert.equal(typeof devtoolsEsm.FluxDevtools, "function");
  for (const packageName of ["core", "codegen", "next", "devtools"]) {
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(installedRoot, "@fluxfast", packageName, "package.json"),
      "utf8"
    ));
    assert.match(packageJson.exports["."].import, /^\.\/dist\/esm\//);
  }
  assert.throws(
    () => require("@fluxfast/next/dist/index.js"),
    error => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
  await assert.rejects(
    import("@fluxfast/next/src/index.js"),
    error => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
  assert.equal(fs.existsSync(path.join(installedRoot, ".bin", "fluxfast")), true);
  assert.equal(fs.existsSync(path.join(installedRoot, ".bin", "fluxfast-codegen")), true);
  for (const packageName of ["core", "codegen", "next", "devtools"]) {
    const license = fs.readFileSync(
      path.join(installedRoot, "@fluxfast", packageName, "LICENSE"),
      "utf8"
    );
    assert.match(license, /MIT License/);
  }

  const store = new core.ResourceStore();
  store.set({ key: "health", version: "v1", value: { ok: true } });
  assert.deepEqual(store.getSnapshot("health"), { ok: true });
  assert.equal(typeof core.encodeKnownVersions(store.exportKnownVersions()), "string");

  const config = nextConfig.withFluxFast({}, {
    backendUrl: "http://127.0.0.1:43123",
    generate: false,
  });
  const rewrites = await config.rewrites();
  assert.equal(Array.isArray(rewrites), false);
  assert.equal(rewrites.beforeFiles[0].destination, "http://127.0.0.1:43123/:path*");
  assert.equal(rewrites.beforeFiles[0].has[0].key, "x-fluxfast");

  const generatedRegistry = path.join(
    process.cwd(),
    "src",
    ".fluxfast",
    "pages.generated.ts"
  );
  assert.equal(fs.existsSync(generatedRegistry), true);
  assert.match(fs.readFileSync(generatedRegistry, "utf8"), /"health\/index"/);
  for (const compiler of [codegen, codegenEsm]) {
    const registry = compiler.createPagesRegistrySnapshot({
      pagesDir: path.join(process.cwd(), "src", "flux-pages"),
      outputFile: generatedRegistry,
      target: {
        runtimeImport: "@fluxfast/next",
        rootExport: "FluxRoot",
        applicationPropsExport: "FluxApplicationProps",
        clientDirective: true,
      },
    });
    assert.equal(registry.content, fs.readFileSync(generatedRegistry, "utf8"));
    const before = fs.statSync(generatedRegistry).mtimeMs;
    assert.equal(compiler.checkFluxFastProject({
      generatedDir: path.dirname(generatedRegistry), registry, log: false,
    }).current, true);
    assert.equal(fs.statSync(generatedRegistry).mtimeMs, before);
  }
  const preservedSchemaOneTypes = path.join(
    process.cwd(),
    "src",
    ".fluxfast",
    "types.generated.ts"
  );
  assert.equal(fs.existsSync(preservedSchemaOneTypes), true);
  assert.match(
    fs.readFileSync(preservedSchemaOneTypes, "utf8"),
    /Schema: fluxfast-schema\/1/
  );

  console.log("JavaScript release artifacts passed the consumer smoke test.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
