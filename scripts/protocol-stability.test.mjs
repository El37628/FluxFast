import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const fixtureDirectory = path.join(repositoryRoot, "tests", "fixtures", "protocol-v1");
const baselinePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "protocol-v1-v0.9.0.json"
);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, normalize(value[key])])
    );
  }
  return value;
}

function semanticDigest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

test("keeps fluxfast/1 semantically identical to the v0.9.0 baseline", () => {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const fixtureDigests = Object.fromEntries(
    fs.readdirSync(fixtureDirectory)
      .filter(name => name.endsWith(".json"))
      .sort()
      .map(name => [
        name,
        semanticDigest(
          JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"))
        ),
      ])
  );

  assert.equal(baseline.packageBaseline, "0.9.0");
  assert.equal(baseline.protocol.version, "fluxfast/1");
  assert.deepEqual(fixtureDigests, baseline.fixtureDigests);
});

test("keeps protocol interpretation independent from package versions", () => {
  const implementationPaths = [
    "packages/core/src/protocol.ts",
    "packages/core/src/transport.ts",
    "packages/core/src/capabilities.ts",
    "packages/core/src/live/client-id.ts",
    "packages/core/src/live/protocol.ts",
    "packages/core/src/live/transport.ts",
    "python/fluxfast/src/fluxfast/protocol.py",
    "python/fluxfast/src/fluxfast/headers.py",
    "python/fluxfast/src/fluxfast/capabilities.py",
    "python/fluxfast/src/fluxfast/live/events.py",
  ];

  for (const relativePath of implementationPaths) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /\bv?(?:0\.9(?:\.0)?|1\.0(?:\.0)?)\b/,
      `${relativePath} must not couple fluxfast/1 semantics to a package version`
    );
  }
});
