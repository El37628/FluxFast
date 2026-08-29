import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareChangelog,
  readVersionSnapshot,
  rewriteVersionFiles,
  validateStableVersion,
} from "./version-files.mjs";

function versionFixture() {
  return {
    "package.json": '{"version":"0.1.0"}\n',
    "packages/core/package.json": '{"version":"0.1.0"}\n',
    "packages/next/package.json":
      '{"version":"0.1.0","dependencies":{"@fluxfast/core":"^0.1.0"}}\n',
    "python/fluxfast/pyproject.toml":
      '[project]\nname = "fluxfast"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\n',
    "python/fluxfast/src/fluxfast/__init__.py": '__version__ = "0.1.0"\n',
    "python/fluxfast/uv.lock": '[[package]]\nname = "fluxfast"\nversion = "0.1.0"\nsource = { editable = "." }\n',
  };
}

test("rewrites every synchronized release version", () => {
  const rewritten = rewriteVersionFiles(versionFixture(), "1.2.3");
  assert.deepEqual(readVersionSnapshot(rewritten), {
    "package.json": "1.2.3",
    "packages/core/package.json": "1.2.3",
    "packages/next/package.json": "1.2.3",
    "python/fluxfast/pyproject.toml": "1.2.3",
    "python/fluxfast/src/fluxfast/__init__.py": "1.2.3",
    "python/fluxfast/uv.lock": "1.2.3",
    "packages/next/package.json @fluxfast/core": "^1.2.3",
  });
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
