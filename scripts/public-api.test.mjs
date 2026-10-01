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
    "ResourceMetadataSnapshot",
    "FluxServerDiagnosticTrace",
  ],
  valueOnly: [
    "DEVTOOLS_PROTOCOL_VERSION",
    "HEADER_DEVTOOLS",
    "HEADER_DEVTOOLS_TRACE",
    "MAX_DEVTOOLS_TRACE_HEADER_CHARS",
    "decodeServerDiagnosticTrace",
  ],
  typeAndValue: ["FluxDiagnosticsHub"],
});

const v11CoreDeclarationChanges = Object.freeze({
  "router.d.ts": "a48826c75584952c90b78bcdb22ac767a508712c2c040aa9afb8002525d45866",
  "store.d.ts": "17990d96eaf8f238d2edb3a1b395dc5e181ee1755422b5fca420750b4c9c13e0",
  "transport.d.ts": "279a82ed912bd349041f556926de99012cefcf0b2693973d0788cff58d5582e7",
});

const v11NextAdditions = Object.freeze({
  ".": Object.freeze({ typeOnly: ["FluxDevelopmentMetadata"] }),
  "./client": Object.freeze({ typeOnly: ["FluxDevelopmentMetadata"] }),
});

const v11NextDeclarationChanges = Object.freeze({
  ".": Object.freeze({
    "config.d.ts": "412db26e36ba5c810328b30aa574e43cb9972dff564b5af0aebbb92866b357cc",
    "provider.d.ts": "8b849865648a1f2ddc008d5e63447e659c8ae5134604c698fecf6b1f189e25b5",
    "root.d.ts": "9643e74f6f9bc7a4654a97eced01414d26226543348d5a460d938969755cba92",
  }),
  "./client": Object.freeze({
    "config.d.ts": "412db26e36ba5c810328b30aa574e43cb9972dff564b5af0aebbb92866b357cc",
    "provider.d.ts": "8b849865648a1f2ddc008d5e63447e659c8ae5134604c698fecf6b1f189e25b5",
    "root.d.ts": "9643e74f6f9bc7a4654a97eced01414d26226543348d5a460d938969755cba92",
  }),
  "./server": Object.freeze({
    "config.d.ts": "412db26e36ba5c810328b30aa574e43cb9972dff564b5af0aebbb92866b357cc",
  }),
});

const v11DevtoolsContract = Object.freeze({
  entries: Object.freeze({
    ".": Object.freeze({
      typeOnly: ["FluxDevtoolsProps"],
      valueOnly: ["FluxDevtools"],
    }),
  }),
  exportMap: Object.freeze({
    ".": Object.freeze({
      types: "./dist/index.d.ts",
      development: Object.freeze({
        import: "./dist/esm/index.js",
        require: "./dist/index.js",
      }),
      production: Object.freeze({
        import: "./dist/esm/disabled.js",
        require: "./dist/disabled.js",
      }),
      import: "./dist/esm/index.js",
      require: "./dist/index.js",
      default: "./dist/index.js",
    }),
  }),
});

test("keeps the v0.9 JavaScript contract with reviewed v1.1 and server additions", () => {
  const expected = JSON.parse(fs.readFileSync(v09BaselinePath, "utf8"));
  const current = createPublicApiSnapshot();
  const expectedCoreEntries = structuredClone(
    expected.packages["@fluxfast/core"].entries
  );
  for (const [group, names] of Object.entries(v11CoreAdditions)) {
    expectedCoreEntries["."][group].push(...names);
    expectedCoreEntries["."][group].sort();
  }
  expectedCoreEntries["./server"] = {
    typeOnly: [
      "FetchFluxInitialPageOptions",
      "FluxDevelopmentMetadata",
      "FluxInitialPageResult",
      "FluxTransportProxyOptions",
    ],
    valueOnly: ["fetchFluxInitialPage", "removeFluxHopByHopHeaders", "selectFluxForwardHeaders"],
  };

  assert.deepEqual(
    current.packages["@fluxfast/core"].entries,
    expectedCoreEntries
  );
  assert.deepEqual(
    current.packages["@fluxfast/core"].exportMap,
    {
      ...expected.packages["@fluxfast/core"].exportMap,
      "./server": {
        types: "./dist/server/index.d.ts",
        import: "./dist/esm/server/index.js",
        require: "./dist/server/index.js",
      },
    }
  );
  const expectedCoreFiles =
    expected.packages["@fluxfast/core"].declarations["."].files;
  const currentCoreFiles =
    current.packages["@fluxfast/core"].declarations["."].files;
  for (const [file, fingerprint] of Object.entries(expectedCoreFiles)) {
    if (file === "index.d.ts") continue;
    assert.equal(
      currentCoreFiles[file],
      v11CoreDeclarationChanges[file] ?? fingerprint,
      `${file} changed`
    );
  }
  assert.deepEqual(
    Object.keys(currentCoreFiles).filter(file => !(file in expectedCoreFiles)),
    ["diagnostics.d.ts"]
  );
  assert.equal(
    currentCoreFiles["diagnostics.d.ts"],
    "b8e0637ca5a7197b3de19662c323bed71b1dbbe5fdce3c9f1bb8db83e17986dd"
  );
  assert.deepEqual(
    current.packages["@fluxfast/core"].declarations["./server"].files,
    {
      "diagnostics.d.ts": "b8e0637ca5a7197b3de19662c323bed71b1dbbe5fdce3c9f1bb8db83e17986dd",
      "protocol.d.ts": "572e3e81f256530cfc13b32660da87524eef887b619e27b16a0d8f30ac15c6ef",
      "server/headers.d.ts": "1f696d768bcbf845abda5977ccd16537d99efbf741f2ad798b272c72eb9c3f08",
      "server/index.d.ts": "281e021cc84ef876e70b1ad84a3d8763776795e910b546449c8acebd5d3e4484",
      "server/initial-page.d.ts": "abac2e2dfc608bfd0475af6ec5cf41bf930bf7e3aa939e004dd9a854a8da0604",
      "server/types.d.ts": "a3181ec6ad068a9dba64c752a3112c61a1019bcd202ebeb91e8de06254d54dc7",
      "transport.d.ts": "279a82ed912bd349041f556926de99012cefcf0b2693973d0788cff58d5582e7",
    }
  );

  const expectedNextEntries = structuredClone(
    expected.packages["@fluxfast/next"].entries
  );
  for (const [entry, groups] of Object.entries(v11NextAdditions)) {
    for (const [group, names] of Object.entries(groups)) {
      expectedNextEntries[entry][group].push(...names);
      expectedNextEntries[entry][group].sort();
    }
  }
  assert.deepEqual(
    current.packages["@fluxfast/next"].entries,
    expectedNextEntries
  );
  assert.deepEqual(
    current.packages["@fluxfast/next"].bin,
    expected.packages["@fluxfast/next"].bin
  );
  assert.deepEqual(
    current.packages["@fluxfast/next"].exportMap,
    expected.packages["@fluxfast/next"].exportMap
  );
  for (const [entry, declaration] of Object.entries(
    expected.packages["@fluxfast/next"].declarations
  )) {
    const currentFiles = current.packages["@fluxfast/next"]
      .declarations[entry].files;
    for (const [file, fingerprint] of Object.entries(declaration.files)) {
      assert.equal(
        currentFiles[file],
        v11NextDeclarationChanges[entry]?.[file] ?? fingerprint,
        `${entry} ${file} changed`
      );
    }
    assert.deepEqual(Object.keys(currentFiles), Object.keys(declaration.files));
  }

  assert.deepEqual(
    current.packages["@fluxfast/devtools"].entries,
    v11DevtoolsContract.entries
  );
  assert.deepEqual(
    current.packages["@fluxfast/devtools"].exportMap,
    v11DevtoolsContract.exportMap
  );
  assert.deepEqual(
    current.packages["@fluxfast/devtools"].declarations["."].files,
    {
      "devtools.d.ts": "85f4df704170801f75481e2ce54ca0e9ad45bf4da3f4bf22336c1ca3bed619c5",
      "index.d.ts": "e419f4c8182428f3ebbbe175307b0cfae0b54cb4a02615f6ac6958027622d71b",
    }
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
