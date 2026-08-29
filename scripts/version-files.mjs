export const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export const VERSION_FILES = [
  "package.json",
  "packages/core/package.json",
  "packages/next/package.json",
  "pnpm-lock.yaml",
  "python/fluxfast/pyproject.toml",
  "python/fluxfast/src/fluxfast/__init__.py",
  "python/fluxfast/uv.lock",
];

const JSON_MANIFESTS = VERSION_FILES.slice(0, 3);

export function validateStableVersion(version) {
  if (!STABLE_VERSION.test(version ?? "")) {
    throw new TypeError("Version must use the stable MAJOR.MINOR.PATCH format.");
  }
}

export function hasDatedReleaseSection(changelog, version) {
  validateStableVersion(version);
  const headingPrefix = `## [${version}] - `;
  return changelog.split(/\r?\n/).some(line => {
    if (!line.startsWith(headingPrefix)) return false;
    return /^\d{4}-\d{2}-\d{2}$/.test(line.slice(headingPrefix.length));
  });
}

function replaceExactlyOnce(contents, pattern, replacement, file) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matches = contents.match(new RegExp(pattern.source, flags));
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one version field in ${file}.`);
  }
  return contents.replace(pattern, replacement);
}

export function rewriteVersionFiles(files, version) {
  validateStableVersion(version);
  const rewritten = { ...files };

  for (const file of JSON_MANIFESTS) {
    const manifest = JSON.parse(files[file]);
    manifest.version = version;
    if (file === "packages/next/package.json") {
      manifest.dependencies["@fluxfast/core"] = `^${version}`;
    }
    rewritten[file] = `${JSON.stringify(manifest, null, 2)}\n`;
  }

  const pnpmLockFile = "pnpm-lock.yaml";
  rewritten[pnpmLockFile] = replaceExactlyOnce(
    files[pnpmLockFile],
    /(\n  packages\/next:\n    dependencies:\n      '@fluxfast\/core':\n        specifier: )[^\n]+/,
    `$1^${version}`,
    pnpmLockFile
  );

  const pyprojectFile = "python/fluxfast/pyproject.toml";
  const projectSection =
    /(\[project\][\s\S]*?\nversion\s*=\s*")[^"]+("(?:\n|$))/;
  rewritten[pyprojectFile] = replaceExactlyOnce(
    files[pyprojectFile],
    projectSection,
    `$1${version}$2`,
    pyprojectFile
  );

  const initFile = "python/fluxfast/src/fluxfast/__init__.py";
  rewritten[initFile] = replaceExactlyOnce(
    files[initFile],
    /(^__version__\s*=\s*")[^"]+("$)/m,
    `$1${version}$2`,
    initFile
  );

  const lockFile = "python/fluxfast/uv.lock";
  rewritten[lockFile] = replaceExactlyOnce(
    files[lockFile],
    /(\[\[package\]\]\nname = "fluxfast"\nversion = ")[^"]+("\n)/,
    `$1${version}$2`,
    lockFile
  );

  return rewritten;
}

export function readVersionSnapshot(files) {
  const snapshot = {};
  for (const file of JSON_MANIFESTS) {
    snapshot[file] = JSON.parse(files[file]).version;
  }

  const pnpmLockFile = "pnpm-lock.yaml";
  snapshot[`${pnpmLockFile} @fluxfast/core`] = files[pnpmLockFile].match(
    /\n  packages\/next:\n    dependencies:\n      '@fluxfast\/core':\n        specifier: ([^\n]+)/
  )?.[1];

  const pyprojectFile = "python/fluxfast/pyproject.toml";
  const projectSection = files[pyprojectFile].match(
    /\[project\]([\s\S]*?)(?:\n\[|$)/
  )?.[1];
  snapshot[pyprojectFile] = projectSection?.match(
    /^version\s*=\s*"([^"]+)"/m
  )?.[1];

  const initFile = "python/fluxfast/src/fluxfast/__init__.py";
  snapshot[initFile] = files[initFile].match(
    /^__version__\s*=\s*"([^"]+)"/m
  )?.[1];

  const lockFile = "python/fluxfast/uv.lock";
  snapshot[lockFile] = files[lockFile].match(
    /\[\[package\]\]\nname = "fluxfast"\nversion = "([^"]+)"/
  )?.[1];

  snapshot["packages/next/package.json @fluxfast/core"] = JSON.parse(
    files["packages/next/package.json"]
  ).dependencies?.["@fluxfast/core"];
  return snapshot;
}

export function prepareChangelog(changelog, version, date) {
  validateStableVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError("Release date must use YYYY-MM-DD format.");
  }
  if (changelog.includes(`## [${version}] - `)) return changelog;
  const marker = "## [Unreleased]";
  if (!changelog.includes(marker)) {
    throw new Error("CHANGELOG.md must contain an Unreleased section.");
  }
  let prepared = changelog.replace(
    marker,
    `${marker}\n\n## [${version}] - ${date}`
  );
  const comparison = prepared.match(
    /^\[Unreleased\]: (https:\/\/github\.com\/[^/]+\/[^/]+)\/compare\/v\d+\.\d+\.\d+\.\.\.HEAD$/m
  );
  if (comparison) {
    const repository = comparison[1];
    prepared = prepared.replace(
      comparison[0],
      `[Unreleased]: ${repository}/compare/v${version}...HEAD`
    );
    prepared = `${prepared.trimEnd()}\n[${version}]: ${repository}/releases/tag/v${version}\n`;
  }
  return prepared;
}
