const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("@fluxfast/core");
const nextAdapter = require("@fluxfast/next");
const { withFluxFast } = require("@fluxfast/next/next-config");

async function main() {
  const installedRoot = path.join(process.cwd(), "node_modules");
  const coreEntry = require.resolve("@fluxfast/core");
  const nextEntry = require.resolve("@fluxfast/next");

  assert.equal(coreEntry.startsWith(installedRoot), true);
  assert.equal(nextEntry.startsWith(installedRoot), true);
  assert.equal(typeof core.createFluxRuntime, "function");
  assert.equal(typeof nextAdapter.defineFluxConfig, "function");
  const [
    coreEsm,
    nextEsm,
    nextClientEsm,
    nextGenerateEsm,
    nextConfigEsm,
  ] = await Promise.all([
    import("@fluxfast/core"),
    import("@fluxfast/next"),
    import("@fluxfast/next/client"),
    import("@fluxfast/next/generate"),
    import("@fluxfast/next/next-config"),
  ]);
  assert.equal(typeof coreEsm.createValidator, "function");
  assert.equal(typeof nextEsm.useForm, "function");
  assert.equal(typeof nextClientEsm.useForm, "function");
  assert.equal(typeof nextGenerateEsm.generateFluxFastProject, "function");
  assert.equal(typeof nextConfigEsm.withFluxFast, "function");
  for (const packageName of ["core", "next"]) {
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(installedRoot, "@fluxfast", packageName, "package.json"),
      "utf8"
    ));
    assert.match(packageJson.exports["."].import, /^\.\/dist\/esm\//);
  }
  assert.equal(fs.existsSync(path.join(installedRoot, ".bin", "fluxfast")), true);
  for (const packageName of ["core", "next"]) {
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

  const config = withFluxFast({}, {
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
