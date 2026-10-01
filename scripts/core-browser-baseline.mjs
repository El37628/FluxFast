import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Hash only JavaScript reachable from the package's two browser root entries. */
export function collectCoreBrowserModules(packageRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const pending = [manifest.exports["."].require, manifest.exports["."].import];
  const files = new Map();
  while (pending.length > 0) {
    const name = path.posix.normalize(pending.pop());
    if (files.has(name)) continue;
    if (!name.startsWith("dist/") || name.includes("/server/")) {
      throw new Error(`Browser Core entry reached an unexpected module: ${name}`);
    }
    const source = fs.readFileSync(path.join(packageRoot, name), "utf8");
    files.set(name, crypto.createHash("sha256").update(source).digest("hex"));
    const imports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
    for (const [, specifier] of source.matchAll(imports)) {
      if (!specifier.startsWith(".")) {
        throw new Error(`Browser Core entry imported an external module: ${specifier}`);
      }
      pending.push(path.posix.join(path.posix.dirname(name), specifier));
    }
  }
  return Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)));
}
