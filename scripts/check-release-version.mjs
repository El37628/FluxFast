#!/usr/bin/env node

import fs from "node:fs";

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("Release tag must use the stable vMAJOR.MINOR.PATCH format.");
  process.exit(1);
}

const expectedVersion = tag.slice(1);
const packageFiles = [
  "package.json",
  "packages/core/package.json",
  "packages/next/package.json",
];
const mismatches = [];

for (const packageFile of packageFiles) {
  const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (manifest.version !== expectedVersion) {
    mismatches.push(`${packageFile}: ${manifest.version ?? "missing"}`);
  }
}

const pyprojectFile = "python/fluxfast/pyproject.toml";
const pyproject = fs.readFileSync(pyprojectFile, "utf8");
const projectSection = pyproject.match(/\[project\]([\s\S]*?)(?:\n\[|$)/)?.[1];
const pythonVersion = projectSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pythonVersion !== expectedVersion) {
  mismatches.push(`${pyprojectFile}: ${pythonVersion ?? "missing"}`);
}

const pythonInitFile = "python/fluxfast/src/fluxfast/__init__.py";
const pythonInit = fs.readFileSync(pythonInitFile, "utf8");
const runtimeVersion = pythonInit.match(/^__version__\s*=\s*"([^"]+)"/m)?.[1];
if (runtimeVersion !== expectedVersion) {
  mismatches.push(`${pythonInitFile}: ${runtimeVersion ?? "missing"}`);
}

const nextManifest = JSON.parse(
  fs.readFileSync("packages/next/package.json", "utf8")
);
const expectedCoreRange = `^${expectedVersion}`;
const coreRange = nextManifest.dependencies?.["@fluxfast/core"];
if (coreRange !== expectedCoreRange) {
  mismatches.push(
    `packages/next/package.json @fluxfast/core: ${coreRange ?? "missing"}`
  );
}

if (mismatches.length > 0) {
  console.error(`Release ${tag} does not match every package version:`);
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log(`Release ${tag} matches every package version and dependency.`);
