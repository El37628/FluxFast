import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPublicApiSnapshot } from "./public-api-snapshot.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const baselinePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "public-api-v0.8.1.json"
);

test("keeps the v0.8.1 JavaScript public API baseline explicit", () => {
  const expected = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.deepEqual(createPublicApiSnapshot(), { packages: expected.packages });
});
