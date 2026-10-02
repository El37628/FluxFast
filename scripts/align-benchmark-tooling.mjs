import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Remove only the new workspace topology absent from the immutable v0.9 tree. */
export function baselineComparisonTooling(name, source) {
  if (name === "packages/next/package.json") {
    const manifest = JSON.parse(source);
    if (!manifest.dependencies?.["@fluxfast/codegen"] && !manifest.dependencies?.["@fluxfast/react"]) return source;
    delete manifest.dependencies["@fluxfast/codegen"];
    delete manifest.dependencies["@fluxfast/react"];
    return JSON.stringify(manifest, null, 2) + "\n";
  }
  if (name !== "pnpm-lock.yaml" || !source.includes("\n  packages/codegen:\n")) return source;
  const importer = /\n  packages\/codegen:\n[\s\S]*?(?=\n  \S|\npackages:|\nsnapshots:|$)/g;
  assert.equal([...source.matchAll(importer)].length, 1, "one Codegen importer required");
  const next = /\n  packages\/next:\n[\s\S]*?(?=\n  \S|\npackages:|\nsnapshots:|$)/g;
  assert.equal([...source.matchAll(next)].length, 1, "one Next importer required");
  const dependency = /      '@fluxfast\/codegen':\n        specifier: [^\n]+\n        version: link:\.\.\/codegen\n/g;
  let normalized = source.replace(importer, "").replace(next, block => {
    assert.equal([...block.matchAll(dependency)].length, 1, "one linked Next/Codegen dependency required");
    return block.replace(dependency, "");
  });
  if (source.includes("\n  packages/react:\n")) {
    const reactImporter = /\n  packages\/react:\n[\s\S]*?(?=\n  \S|\npackages:|\nsnapshots:|$)/g;
    assert.equal([...source.matchAll(reactImporter)].length, 1, "one React importer required");
    normalized = normalized.replace(reactImporter, "").replace(/      '@fluxfast\/react':\n        specifier: [^\n]+\n        version: link:\.\.\/react\n/g, "");
  }
  if (source.includes("\n  packages/vite:\n")) {
    const viteImporter = /\n  packages\/vite:\n[\s\S]*?(?=\n  \S|\npackages:|\nsnapshots:|$)/g;
    assert.equal([...source.matchAll(viteImporter)].length, 1, "one Vite host importer required");
    normalized = normalized.replace(viteImporter, "");
  }
  if (source.includes("\n  tests/browser/react-frontend:\n")) {
    const reactFixture = /\n  tests\/browser\/react-frontend:\n[\s\S]*?(?=\n  \S|\npackages:|\nsnapshots:|$)/g;
    assert.equal([...source.matchAll(reactFixture)].length, 1, "one React browser fixture importer required");
    normalized = normalized.replace(reactFixture, "");
  }
  return normalized;
}

function main(baseline) {
  assert.ok(baseline, "a v0.9.0 comparison checkout is required");
  const target = fs.realpathSync(path.resolve(baseline));
  assert.notEqual(target, fs.realpathSync(repository), "cannot normalize the candidate checkout");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", shell: false });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(git("-C", target, "rev-parse", "HEAD"), git("rev-parse", "v0.9.0^{}"));
  for (const name of ["packages/next/package.json", "pnpm-lock.yaml"]) {
    const source = fs.readFileSync(path.join(repository, name), "utf8");
    assert.equal(fs.readFileSync(path.join(target, name), "utf8"), source, "copy current tooling before normalization");
    fs.writeFileSync(path.join(target, name), baselineComparisonTooling(name, source));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2]);
