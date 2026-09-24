import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const sourceRoots = [
  "packages/core/src",
  "packages/next/src",
  "python/fluxfast/src/fluxfast",
];
const versionNormalizedPaths = [
  "python/fluxfast/src/fluxfast/__init__.py",
];

function runtimeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__pycache__" ? [] : runtimeFiles(absolute);
    }
    if (!entry.isFile()) {
      throw new Error(`runtime source contains unsupported entry: ${absolute}`);
    }
    return [path.relative(repositoryRoot, absolute).split(path.sep).join("/")];
  });
}

function normalizedSource(relativePath) {
  let source = fs
    .readFileSync(path.join(repositoryRoot, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
  if (versionNormalizedPaths.includes(relativePath)) {
    const versionLines = source.match(/^__version__ = "[0-9]+\.[0-9]+\.[0-9]+"$/gm);
    if (versionLines?.length !== 1) {
      throw new Error(`${relativePath} must contain exactly one stable version line`);
    }
    source = source.replace(
      /^__version__ = "[0-9]+\.[0-9]+\.[0-9]+"$/m,
      '__version__ = "<VERSION>"'
    );
  }
  return source;
}

export function createRuntimeFreezeSnapshot() {
  const files = sourceRoots
    .flatMap(root => runtimeFiles(path.join(repositoryRoot, root)))
    .sort();
  const digest = crypto.createHash("sha256");
  for (const relativePath of files) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(normalizedSource(relativePath));
    digest.update("\0");
  }
  return {
    sourceRoots,
    versionNormalizedPaths,
    runtimeFileCount: files.length,
    runtimeDigest: digest.digest("hex"),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(JSON.stringify(createRuntimeFreezeSnapshot(), null, 2));
}
