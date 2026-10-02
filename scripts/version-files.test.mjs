import assert from "node:assert/strict";
import test from "node:test";

import {
  hasDatedReleaseSection,
  prepareChangelog,
  readVersionSnapshot,
  rewriteVersionFiles,
  validateStableVersion,
} from "./version-files.mjs";

function versionFixture() {
  const files = {
    "package.json": '{"version":"0.1.0"}\n',
    "packages/core/package.json": '{"version":"0.1.0"}\n',
    "packages/codegen/package.json": '{"version":"0.1.0","dependencies":{"@fluxfast/core":"^0.1.0"}}\n',
    "packages/react/package.json": '{"version":"0.1.0","dependencies":{"@fluxfast/core":"^0.1.0"}}\n',
    "packages/vite/package.json": '{"version":"0.1.0","dependencies":{"@fluxfast/codegen":"^0.1.0","@fluxfast/core":"^0.1.0","@fluxfast/react":"^0.1.0"}}\n',
    "packages/next/package.json":
      '{"version":"0.1.0","dependencies":{"@fluxfast/codegen":"^0.1.0","@fluxfast/core":"^0.1.0","@fluxfast/react":"^0.1.0"}}\n',
    "packages/devtools/package.json": '{"version":"0.1.0","dependencies":{"@fluxfast/react":"^0.1.0"}}\n',
    "pnpm-lock.yaml":
      "lockfileVersion: '9.0'\n\nimporters:\n\n  packages/codegen:\n    dependencies:\n      '@fluxfast/core':\n        specifier: ^0.1.0\n        version: link:../core\n\n  packages/devtools:\n    dependencies:\n      '@fluxfast/react':\n        specifier: ^0.1.0\n        version: link:../react\n\n  packages/react:\n    dependencies:\n      '@fluxfast/core':\n        specifier: ^0.1.0\n        version: link:../core\n\n  packages/next:\n    dependencies:\n      '@fluxfast/codegen':\n        specifier: ^0.1.0\n        version: link:../codegen\n      '@fluxfast/react':\n        specifier: ^0.1.0\n        version: link:../react\n      '@fluxfast/core':\n        specifier: ^0.1.0\n        version: link:../core\n",
    "python/fluxfast/pyproject.toml":
      '[project]\nname = "fluxfast"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\n',
    "python/fluxfast/src/fluxfast/__init__.py": '__version__ = "0.1.0"\n',
    "python/fluxfast/uv.lock": '[[package]]\nname = "fluxfast"\nversion = "0.1.0"\nsource = { editable = "." }\n',
  };
  files["pnpm-lock.yaml"] += "\n  packages/vite:\n    dependencies:\n      '@fluxfast/codegen':\n        specifier: ^0.1.0\n        version: link:../codegen\n      '@fluxfast/core':\n        specifier: ^0.1.0\n        version: link:../core\n      '@fluxfast/react':\n        specifier: ^0.1.0\n        version: link:../react\n";
  return files;
}

test("rewrites every synchronized release version", () => {
  const rewritten = rewriteVersionFiles(versionFixture(), "1.2.3");
  assert.deepEqual(readVersionSnapshot(rewritten), {
    "package.json": "1.2.3",
    "packages/core/package.json": "1.2.3",
    "packages/codegen/package.json": "1.2.3",
    "packages/react/package.json": "1.2.3",
    "packages/vite/package.json": "1.2.3",
    "packages/next/package.json": "1.2.3",
    "packages/devtools/package.json": "1.2.3",
    "pnpm-lock.yaml @fluxfast/core": "^1.2.3",
    "pnpm-lock.yaml @fluxfast/codegen": "^1.2.3",
    "pnpm-lock.yaml @fluxfast/react": "^1.2.3",
    "pnpm-lock.yaml packages/react @fluxfast/core": "^1.2.3",
    "pnpm-lock.yaml packages/devtools @fluxfast/react": "^1.2.3",
    "pnpm-lock.yaml packages/codegen @fluxfast/core": "^1.2.3",
    "pnpm-lock.yaml packages/vite @fluxfast/core": "^1.2.3",
    "pnpm-lock.yaml packages/vite @fluxfast/codegen": "^1.2.3",
    "pnpm-lock.yaml packages/vite @fluxfast/react": "^1.2.3",
    "python/fluxfast/pyproject.toml": "1.2.3",
    "python/fluxfast/src/fluxfast/__init__.py": "1.2.3",
    "python/fluxfast/uv.lock": "1.2.3",
    "packages/next/package.json @fluxfast/core": "^1.2.3",
    "packages/next/package.json @fluxfast/codegen": "^1.2.3",
    "packages/codegen/package.json @fluxfast/core": "^1.2.3",
    "packages/next/package.json @fluxfast/react": "^1.2.3",
    "packages/react/package.json @fluxfast/core": "^1.2.3",
    "packages/devtools/package.json @fluxfast/react": "^1.2.3",
    "packages/vite/package.json @fluxfast/core": "^1.2.3",
    "packages/vite/package.json @fluxfast/codegen": "^1.2.3",
    "packages/vite/package.json @fluxfast/react": "^1.2.3",
  });
});

test("release rewriting confines each dependency to its own workspace importer", () => {
  const files = versionFixture();
  files["pnpm-lock.yaml"] += "\n  unrelated:\n    dependencies:\n      '@fluxfast/core':\n        specifier: ^0.9.0\n        version: 0.9.0\n";
  const rewritten = rewriteVersionFiles(files, "1.2.3");
  assert.match(rewritten["pnpm-lock.yaml"], /unrelated:[\s\S]*specifier: \^0\.9\.0/);
  assert.equal(readVersionSnapshot(rewritten)["pnpm-lock.yaml @fluxfast/codegen"], "^1.2.3");
});

test("promotes unreleased changelog entries exactly once", () => {
  const source = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Feature.",
    "",
    "[Unreleased]: https://github.com/El37628/FluxFast/compare/v1.2.2...HEAD",
    "[1.2.2]: https://github.com/El37628/FluxFast/releases/tag/v1.2.2",
    "",
  ].join("\n");
  const prepared = prepareChangelog(source, "1.2.3", "2026-08-29");
  assert.match(prepared, /## \[Unreleased\]\n\n## \[1\.2\.3\] - 2026-08-29\n\n### Added/);
  assert.match(prepared, /\[Unreleased\]: .*\/compare\/v1\.2\.3\.\.\.HEAD/);
  assert.match(prepared, /\[1\.2\.3\]: .*\/releases\/tag\/v1\.2\.3/);
  assert.equal(prepareChangelog(prepared, "1.2.3", "2026-08-30"), prepared);
});

test("rejects prerelease and incomplete versions", () => {
  for (const version of ["v1.2.3", "1.2", "1.2.3-beta.1", ""]) {
    assert.throws(() => validateStableVersion(version), /MAJOR\.MINOR\.PATCH/);
  }
});

test("matches only an exact dated release heading", () => {
  const changelog = [
    "## [1.2.30] - 2026-08-28",
    "## [1.2.3] - 2026-08-29",
    "## [1x2x3] - 2026-08-30",
  ].join("\n");

  assert.equal(hasDatedReleaseSection(changelog, "1.2.3"), true);
  assert.equal(hasDatedReleaseSection(changelog, "1.2.30"), true);
  assert.equal(hasDatedReleaseSection(changelog, "1.2.4"), false);
  assert.throws(
    () => hasDatedReleaseSection(changelog, "1.2.3.*"),
    /MAJOR\.MINOR\.PATCH/
  );
});
