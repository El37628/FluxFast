#!/usr/bin/env node

import fs from "node:fs";
import {
  VERSION_FILES,
  prepareChangelog,
  rewriteVersionFiles,
  validateStableVersion,
} from "./version-files.mjs";

const version = process.argv[2];
try {
  validateStableVersion(version);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const files = Object.fromEntries(
  VERSION_FILES.map(file => [file, fs.readFileSync(file, "utf8")])
);
const rewritten = rewriteVersionFiles(files, version);
const releaseDate = new Date().toISOString().slice(0, 10);
rewritten["CHANGELOG.md"] = prepareChangelog(
  fs.readFileSync("CHANGELOG.md", "utf8"),
  version,
  releaseDate
);

const changed = [];
for (const [file, contents] of Object.entries(rewritten)) {
  if (contents === (files[file] ?? fs.readFileSync(file, "utf8"))) continue;
  fs.writeFileSync(file, contents, "utf8");
  changed.push(file);
}

if (changed.length === 0) {
  console.log(`Release files already use ${version}.`);
} else {
  console.log(`Prepared ${version} in ${changed.length} release files:`);
  for (const file of changed) console.log(`- ${file}`);
}
