import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import * as server from "../src/server/index.js";

type CoreBaseline = {
  packages: {
    "@fluxfast/core": {
      entries: {
        ".": Record<string, string[]>;
      };
    };
  };
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const apiDocumentPath = path.join(repositoryRoot, "docs/core-api.md");
const baselinePath = path.join(
  repositoryRoot,
  "tests/fixtures/public-api-v0.9.0.json"
);
const v11Additions = [
  "DEVTOOLS_PROTOCOL_VERSION",
  "FluxDiagnosticEvent",
  "FluxDiagnosticEventType",
  "FluxDiagnosticListener",
  "FluxDiagnosticsHub",
  "FluxServerDiagnosticTrace",
  "HEADER_DEVTOOLS",
  "HEADER_DEVTOOLS_TRACE",
  "MAX_DEVTOOLS_TRACE_HEADER_CHARS",
  "ResourceMetadataSnapshot",
  "decodeServerDiagnosticTrace",
];

function namesBetween(start: string, end: string): string[] {
  const document = fs.readFileSync(apiDocumentPath, "utf8");
  const section = document.split(start, 2)[1]?.split(end, 1)[0];
  if (section === undefined) {
    throw new Error(`Missing public API classification markers: ${start}, ${end}`);
  }
  const codeBlock = section.match(/```text\n([\s\S]*?)\n```/);
  if (!codeBlock) throw new Error(`Missing classification code block after ${start}`);
  return codeBlock[1]
    .split("\n")
    .map(name => name.trim())
    .filter(Boolean);
}

function baselineNames(): string[] {
  const baseline = JSON.parse(
    fs.readFileSync(baselinePath, "utf8")
  ) as CoreBaseline;
  return Object.values(
    baseline.packages["@fluxfast/core"].entries["."]
  ).flat();
}

describe("1.x public API classification", () => {
  it("classifies every separate server export without leaking it into the root", () => {
    const names = namesBetween(
      "<!-- core-server-api-advanced:start -->",
      "<!-- core-server-api-advanced:end -->"
    );
    expect(names).toEqual([
      "FetchFluxInitialPageOptions", "FluxDevelopmentMetadata",
      "FluxInitialPageResult", "FluxTransportProxyOptions",
      "fetchFluxInitialPage",
      "removeFluxHopByHopHeaders", "selectFluxForwardHeaders",
    ]);
    expect(Object.keys(server).toSorted()).toEqual([
      "fetchFluxInitialPage",
      "removeFluxHopByHopHeaders", "selectFluxForwardHeaders",
    ]);
    for (const name of names) expect(name in core).toBe(false);
  });

  it("retains every v0.9 export and classifies reviewed v1.1 additions", () => {
    const stable = namesBetween(
      "<!-- core-api-stable:start -->",
      "<!-- core-api-stable:end -->"
    );
    const advanced = namesBetween(
      "<!-- core-api-advanced:start -->",
      "<!-- core-api-advanced:end -->"
    );
    const classified = [...stable, ...advanced];

    expect(stable).toHaveLength(49);
    expect(advanced).toHaveLength(118);
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.toSorted()).toEqual(
      [...baselineNames(), ...v11Additions].toSorted()
    );
    expect(advanced.filter(name => v11Additions.includes(name))).toEqual(
      v11Additions
    );
  });

  it("keeps the principal core families intentionally classified", () => {
    const stable = new Set(
      namesBetween(
        "<!-- core-api-stable:start -->",
        "<!-- core-api-stable:end -->"
      )
    );
    const advanced = new Set(
      namesBetween(
        "<!-- core-api-advanced:start -->",
        "<!-- core-api-advanced:end -->"
      )
    );

    for (const name of [
      "FluxResourceMap",
      "FluxResourceKey",
      "FluxResourceValue",
      "FluxRouter",
      "ResourceStore",
      "FluxValidator",
      "ValidationResult",
      "ValidationIssue",
      "createValidator",
      "refineValidator",
      "formatValidationPath",
      "applyPatchToValue",
    ]) {
      expect(stable.has(name), name).toBe(true);
    }
    for (const name of [
      "FluxTransport",
      "FluxDiagnosticsHub",
      "FluxDiagnosticEvent",
      "HistoryManager",
      "PrefetchManager",
      "LiveManager",
      "LiveTransport",
      "FetchSseLiveTransport",
      "LiveEvent",
      "createClientId",
      "ValidationPlan",
      "compileValidationPlan",
      "PROTOCOL_VERSION",
      "CAPABILITY_LIVE_RESOURCES",
    ]) {
      expect(advanced.has(name), name).toBe(true);
    }
  });
});
