import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const PACKAGE_ENTRIES = Object.freeze({
  "@fluxfast/core": Object.freeze({
    ".": "packages/core/dist/index.d.ts",
  }),
  "@fluxfast/next": Object.freeze({
    ".": "packages/next/dist/index.d.ts",
    "./client": "packages/next/dist/client.d.ts",
    "./generate": "packages/next/dist/generate.d.ts",
    "./next-config": "packages/next/dist/next-config.d.ts",
    "./server": "packages/next/dist/server.d.ts",
  }),
});

function declarationTarget(entry, specifier) {
  if (specifier === "@fluxfast/core") {
    return path.join(repositoryRoot, "packages/core/dist/index.d.ts");
  }
  const resolved = path.resolve(path.dirname(entry), specifier);
  return resolved.endsWith(".js")
    ? `${resolved.slice(0, -3)}.d.ts`
    : `${resolved}.d.ts`;
}

function mergeExport(exports, name, namespaces) {
  const existing = exports.get(name) ?? new Set();
  for (const namespace of namespaces) existing.add(namespace);
  exports.set(name, existing);
}

function parseExportNames(block) {
  return block
    .split(",")
    .map(item => item.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map(item => {
      const [imported, exported = imported] = item.split(/\s+as\s+/);
      return { imported, exported };
    });
}

function declarationExportsFromFile(entry, cache = new Map(), pending = new Set()) {
  if (cache.has(entry)) return cache.get(entry);
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Missing declaration entry ${path.relative(repositoryRoot, entry)}; run pnpm build before checking the API baseline.`
    );
  }
  if (pending.has(entry)) return new Map();
  pending.add(entry);

  const source = fs.readFileSync(entry, "utf8");
  const exports = new Map();
  const declarationPattern =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(interface|type|class|function|const|let|var|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const match of source.matchAll(declarationPattern)) {
    const [, kind, name] = match;
    const namespaces =
      kind === "interface" || kind === "type"
        ? ["type"]
        : kind === "class" || kind === "enum"
          ? ["value", "type"]
          : kind === "namespace"
            ? ["namespace"]
            : ["value"];
    mergeExport(exports, name, namespaces);
  }

  const starPattern = /^export\s+\*\s+from\s+["']([^"']+)["'];?/gm;
  for (const match of source.matchAll(starPattern)) {
    const target = declarationTarget(entry, match[1]);
    for (const [name, namespaces] of declarationExportsFromFile(
      target,
      cache,
      pending
    )) {
      mergeExport(exports, name, namespaces);
    }
  }

  const namedPattern =
    /^export\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?/gm;
  for (const match of source.matchAll(namedPattern)) {
    const typeOnly = Boolean(match[1]);
    const target = declarationTarget(entry, match[3]);
    const targetExports = declarationExportsFromFile(target, cache, pending);
    for (const { imported, exported } of parseExportNames(match[2])) {
      const namespaces = typeOnly ? new Set(["type"]) : targetExports.get(imported);
      if (!namespaces) {
        throw new Error(
          `Unable to resolve ${imported} re-exported by ${path.relative(repositoryRoot, entry)}.`
        );
      }
      mergeExport(exports, exported, namespaces);
    }
  }

  pending.delete(entry);
  cache.set(entry, exports);
  return exports;
}

function declarationExports(relativeEntry) {
  const entry = path.join(repositoryRoot, relativeEntry);
  const groups = {
    typeOnly: [],
    valueOnly: [],
    typeAndValue: [],
    namespace: [],
  };
  for (const [name, namespaces] of declarationExportsFromFile(entry)) {
    if (namespaces.has("namespace")) groups.namespace.push(name);
    if (namespaces.has("type") && namespaces.has("value")) {
      groups.typeAndValue.push(name);
    } else if (namespaces.has("type")) {
      groups.typeOnly.push(name);
    } else if (namespaces.has("value")) {
      groups.valueOnly.push(name);
    }
  }
  for (const names of Object.values(groups)) names.sort();
  return Object.fromEntries(
    Object.entries(groups).filter(([, names]) => names.length > 0)
  );
}

function declarationModuleSpecifiers(source) {
  return [
    ...source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/g),
  ].map(match => match[1]);
}

function declarationTokens(source) {
  const tokenPattern =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][A-Za-z0-9_$]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|./gy;
  const tokens = [];
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^\s/.test(token) || token.startsWith("//") || token.startsWith("/*")) {
      continue;
    }
    tokens.push(token);
  }
  return tokens.join("\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function declarationFingerprint(source) {
  return sha256(declarationTokens(source));
}

function declarationSignatures(relativeEntry) {
  const entry = path.join(repositoryRoot, relativeEntry);
  const distRoot = path.join(
    repositoryRoot,
    ...relativeEntry.split("/").slice(0, 3)
  );
  const pending = [entry];
  const visited = new Set();
  const files = {};

  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    if (!fs.existsSync(current)) {
      throw new Error(
        `Missing declaration dependency ${path.relative(repositoryRoot, current)}; run pnpm build before checking the API baseline.`
      );
    }

    const source = fs.readFileSync(current, "utf8");
    const relative = path.relative(distRoot, current).replaceAll(path.sep, "/");
    files[relative] = declarationFingerprint(source);
    for (const specifier of declarationModuleSpecifiers(source)) {
      const target = declarationTarget(current, specifier);
      if (!target.startsWith(`${distRoot}${path.sep}`)) {
        throw new Error(
          `Declaration dependency escaped package dist: ${path.relative(repositoryRoot, target)}`
        );
      }
      pending.push(target);
    }
  }

  const sortedFiles = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    fingerprint: sha256(JSON.stringify(sortedFiles)),
    files: sortedFiles,
  };
}

function packageManifest(packageDirectory) {
  return JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, packageDirectory, "package.json"),
      "utf8"
    )
  );
}

export function createPublicApiSnapshot() {
  const packages = {};
  for (const [packageName, entries] of Object.entries(PACKAGE_ENTRIES)) {
    packages[packageName] = {
      entries: Object.fromEntries(
        Object.entries(entries).map(([publicPath, declaration]) => [
          publicPath,
          declarationExports(declaration),
        ])
      ),
      declarations: Object.fromEntries(
        Object.entries(entries).map(([publicPath, declaration]) => [
          publicPath,
          declarationSignatures(declaration),
        ])
      ),
    };
  }

  const coreManifest = packageManifest("packages/core");
  const nextManifest = packageManifest("packages/next");
  packages["@fluxfast/core"].exportMap = coreManifest.exports;
  packages["@fluxfast/next"].bin = nextManifest.bin;
  packages["@fluxfast/next"].exportMap = nextManifest.exports;
  return { packages };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(createPublicApiSnapshot(), null, 2)}\n`);
}
