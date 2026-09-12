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
const v081BaselinePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "public-api-v0.8.1.json"
);
const v09BaselinePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "public-api-v0.9.0.json"
);

test("keeps the v0.9 JavaScript promotion baseline exact", () => {
  const expected = JSON.parse(fs.readFileSync(v09BaselinePath, "utf8"));
  assert.deepEqual(createPublicApiSnapshot(), { packages: expected.packages });
});

test("retains the historical v0.8.1 baseline and its reviewed v0.9 delta", () => {
  const historical = JSON.parse(fs.readFileSync(v081BaselinePath, "utf8"));
  const expected = structuredClone(historical);
  expected.packages["@fluxfast/next"].entries["./client"].typeOnly.push(
    "LiveConnectionStatus",
    "LiveStatusSnapshot"
  );
  expected.packages["@fluxfast/next"].entries["./client"].typeOnly.sort();
  expected.packages["@fluxfast/next"].entries["./client"].valueOnly.push(
    "useLiveStatus"
  );
  expected.packages["@fluxfast/next"].entries["./client"].valueOnly.sort();
  const adjacent = JSON.parse(fs.readFileSync(v09BaselinePath, "utf8"));
  assert.deepEqual(adjacent.packages, expected.packages);
});
