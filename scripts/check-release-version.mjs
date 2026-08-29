#!/usr/bin/env node

import fs from "node:fs";
import {
  VERSION_FILES,
  readVersionSnapshot,
  validateStableVersion,
} from "./version-files.mjs";

const tag = process.argv[2];
if (!tag?.startsWith("v")) {
  console.error("Release tag must use the stable vMAJOR.MINOR.PATCH format.");
  process.exit(1);
}

const expectedVersion = tag.slice(1);
try {
  validateStableVersion(expectedVersion);
} catch {
  console.error("Release tag must use the stable vMAJOR.MINOR.PATCH format.");
  process.exit(1);
}

const files = Object.fromEntries(
  VERSION_FILES.map(file => [file, fs.readFileSync(file, "utf8")])
);
const snapshot = readVersionSnapshot(files);
const mismatches = [];

for (const [file, version] of Object.entries(snapshot)) {
  const expected = file.endsWith(" @fluxfast/core")
    ? `^${expectedVersion}`
    : expectedVersion;
  if (version !== expected) mismatches.push(`${file}: ${version ?? "missing"}`);
}

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const escapedVersion = expectedVersion.replaceAll(".", "\\.");
if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  mismatches.push(`CHANGELOG.md: missing dated ${expectedVersion} release section`);
}

if (mismatches.length > 0) {
  console.error(`Release ${tag} does not match every release file:`);
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log(`Release ${tag} matches every package version and changelog entry.`);
