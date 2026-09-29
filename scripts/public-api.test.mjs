import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPublicApiSnapshot,
  declarationFingerprint,
} from "./public-api-snapshot.mjs";

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

const v11CoreAdditions = Object.freeze({
  typeOnly: [
    "FluxDiagnosticEvent",
    "FluxDiagnosticEventType",
    "FluxDiagnosticListener",
  ],
  typeAndValue: ["FluxDiagnosticsHub"],
});

test("keeps the v0.9 JavaScript contract while adding reviewed v1.1 APIs", () => {
  const expected = JSON.parse(fs.readFileSync(v09BaselinePath, "utf8"));
  const current = createPublicApiSnapshot();
  const expectedCoreEntries = structuredClone(
    expected.packages["@fluxfast/core"].entries
  );
  for (const [group, names] of Object.entries(v11CoreAdditions)) {
    expectedCoreEntries["."][group].push(...names);
    expectedCoreEntries["."][group].sort();
  }

  assert.deepEqual(
    current.packages["@fluxfast/core"].entries,
    expectedCoreEntries
  );
  assert.deepEqual(
    current.packages["@fluxfast/core"].exportMap,
    expected.packages["@fluxfast/core"].exportMap
  );
  assert.deepEqual(
    current.packages["@fluxfast/next"],
    expected.packages["@fluxfast/next"]
  );

  const expectedCoreFiles =
    expected.packages["@fluxfast/core"].declarations["."].files;
  const currentCoreFiles =
    current.packages["@fluxfast/core"].declarations["."].files;
  for (const [file, fingerprint] of Object.entries(expectedCoreFiles)) {
    if (file === "index.d.ts") continue;
    assert.equal(currentCoreFiles[file], fingerprint, `${file} changed`);
  }
  assert.deepEqual(
    Object.keys(currentCoreFiles).filter(file => !(file in expectedCoreFiles)),
    ["diagnostics.d.ts"]
  );
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
  const adjacentWithoutSignatures = structuredClone(adjacent.packages);
  for (const packageContract of Object.values(adjacentWithoutSignatures)) {
    delete packageContract.declarations;
  }
  assert.deepEqual(adjacentWithoutSignatures, expected.packages);
});

test("declaration fingerprints ignore trivia but detect signature drift", () => {
  const baseline = `
    /** Stable public function. */
    export declare function load(key: string): Promise<string>;
  `;
  const triviaOnly =
    "export  declare\nfunction load ( key : string ) : Promise < string > ; // same";
  const changed = "export declare function load(key: string): Promise<number>;";

  assert.equal(declarationFingerprint(triviaOnly), declarationFingerprint(baseline));
  assert.notEqual(declarationFingerprint(changed), declarationFingerprint(baseline));
});
