const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const state = process.argv[2];
const originalPage = path.join(root, "src", "app", "page.tsx");
const homePage = path.join(root, "src", "flux-pages", "home", "index.tsx");
const catchAll = path.join(
  root,
  "src",
  "app",
  "(flux)",
  "[[...flux]]",
  "page.tsx"
);
const fluxConfig = path.join(root, "src", "fluxfast.config.ts");
const registry = path.join(root, "src", ".fluxfast", "pages.generated.ts");
const nextConfig = path.join(root, "next.config.ts");

if (state === "dry-run") {
  assert.equal(fs.existsSync(originalPage), true);
  for (const generated of [homePage, catchAll, fluxConfig, registry]) {
    assert.equal(fs.existsSync(generated), false, `${generated} must not exist after dry-run`);
  }
  assert.doesNotMatch(fs.readFileSync(nextConfig, "utf8"), /withFluxFast/);
} else if (state === "initialized") {
  assert.equal(fs.existsSync(originalPage), false);
  for (const generated of [homePage, catchAll, fluxConfig, registry]) {
    assert.equal(fs.existsSync(generated), true, `${generated} must exist after init`);
  }
  const migrated = fs.readFileSync(homePage, "utf8");
  assert.match(migrated, /^"use client";/);
  assert.match(migrated, /from "\.\.\/\.\.\/app\/page\.module\.css"/);
  assert.match(fs.readFileSync(catchAll, "utf8"), /createFluxNextPage/);
  assert.match(fs.readFileSync(fluxConfig, "utf8"), /defineFluxConfig/);
  assert.match(fs.readFileSync(registry, "utf8"), /"home\/index"/);
  assert.match(
    fs.readFileSync(nextConfig, "utf8"),
    /export default withFluxFast\(nextConfig\);/
  );
  assert.equal(fs.existsSync(path.join(root, "node_modules", ".bin", "fluxfast")), true);
} else {
  throw new Error(`Unknown verification state: ${state}`);
}
