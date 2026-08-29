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
  assert.equal(fs.existsSync(path.join(installedRoot, ".bin", "fluxfast")), true);

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

  console.log("JavaScript release artifacts passed the consumer smoke test.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
