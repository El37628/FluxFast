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

test("keeps the reviewed v0.9 JavaScript public API candidate explicit", () => {
  const expected = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  expected.packages["@fluxfast/next"].entries["./client"].typeOnly.push(
    "LiveConnectionStatus",
    "LiveStatusSnapshot"
  );
  expected.packages["@fluxfast/next"].entries["./client"].typeOnly.sort();
  expected.packages["@fluxfast/next"].entries["./client"].valueOnly.push(
    "useLiveStatus"
  );
  expected.packages["@fluxfast/next"].entries["./client"].valueOnly.sort();
  assert.deepEqual(createPublicApiSnapshot(), { packages: expected.packages });
});
