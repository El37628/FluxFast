import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileFluxFastMutations } from "../src/mutation-compiler";
import { compileFluxFastPageRoutes } from "../src/route-compiler";
import { compileFluxFastResourceTypes } from "../src/schema-compiler";
import {
  FLUXFAST_SCHEMA_MANIFEST_V1,
  FLUXFAST_SCHEMA_MANIFEST_V2,
  FLUXFAST_SCHEMA_V2_SHAPE,
  parseFluxFastSchemaManifest,
  validateFluxFastSchemaManifest
} from "../src/schema-manifest";
import { compileFluxFastValidatorsWithDiagnostics } from "../src/validator-compiler";

const fixtureRoot = path.resolve(__dirname, "../../../tests/fixtures/schema");

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, name), "utf8")
  ) as Record<string, unknown>;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, normalizeJson(record[key])])
    );
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeJson(value)))
    .digest("hex");
}

describe("developer schema compatibility freeze", () => {
  it("locks every schema/2 structural field", () => {
    expect(FLUXFAST_SCHEMA_V2_SHAPE).toEqual({
      manifest: [
        "schema",
        "producer",
        "fingerprint",
        "types",
        "resources",
        "pages",
        "mutations"
      ],
      type: ["mode", "schema"],
      resource: ["schema"],
      page: ["name", "path", "parameters"],
      parameter: ["name", "location", "required", "schema"],
      mutationRequired: ["name", "path", "method", "parameters"],
      mutationOptional: ["body"]
    });
  });

  it("reads the shared schema/2 producer fixture across every compiler", () => {
    const baseline = readFixture("developer-schema-v2-v0.9.0.json");
    const source = fs.readFileSync(
      path.join(fixtureRoot, "fluxfast-schema-v2.json"),
      "utf8"
    );
    const manifest = parseFluxFastSchemaManifest(source);

    expect(manifest.schema).toBe(baseline.producedSchema);
    expect(manifest.fingerprint).toBe(baseline.semanticFingerprint);
    expect(canonicalSha256(JSON.parse(source))).toBe(
      baseline.canonicalManifestSha256
    );
    expect(compileFluxFastResourceTypes(manifest)).toContain(
      "export interface User"
    );
    expect(compileFluxFastResourceTypes(manifest)).toContain(
      "export type RoomsResource"
    );
    expect(compileFluxFastPageRoutes(manifest)).toContain("hotelRooms");
    expect(compileFluxFastMutations(manifest)).toContain("updateRoom");
    const validators = compileFluxFastValidatorsWithDiagnostics(manifest);
    expect(validators.content).toContain(
      "CreateRoomInputValidator"
    );
    expect(validators.diagnostics).toEqual([
      expect.objectContaining({ contract: "RoomsResource", keyword: "pattern" })
    ]);
  });

  it("continues reading the shared schema/1 fixture", () => {
    const source = fs.readFileSync(
      path.join(fixtureRoot, "fluxfast-schema-v1.json"),
      "utf8"
    );
    const manifest = parseFluxFastSchemaManifest(source);

    expect(manifest.schema).toBe("fluxfast-schema/1");
    expect(manifest.types).toBeUndefined();
    expect(compileFluxFastResourceTypes(manifest)).toContain(
      "export interface LegacyRoom"
    );
    expect(compileFluxFastPageRoutes(manifest)).toContain("hotelRooms");
    expect(compileFluxFastMutations(manifest)).toContain("updateRoom");
  });

  it("keeps the reader set at schema/1 and schema/2 for the v1 candidate", () => {
    const baseline = readFixture("developer-schema-v2-v0.9.0.json");

    expect([FLUXFAST_SCHEMA_MANIFEST_V1, FLUXFAST_SCHEMA_MANIFEST_V2]).toEqual(
      baseline.supportedReaders
    );

    const candidate = readFixture("fluxfast-schema-v2.json");
    candidate.producer = baseline.candidateProducer;
    expect(validateFluxFastSchemaManifest(candidate)).toEqual(candidate);

    candidate.schema = "fluxfast-schema/3";
    expect(() => validateFluxFastSchemaManifest(candidate)).toThrow(
      /unsupported version "fluxfast-schema\/3"/
    );
  });

  it.each([
    ["manifest", (value: Record<string, unknown>) => {
      value.futureField = true;
    }],
    ["type", (value: Record<string, unknown>) => {
      const types = value.types as Record<string, Record<string, unknown>>;
      types.User.futureField = true;
    }],
    ["resource", (value: Record<string, unknown>) => {
      const resources = value.resources as Record<string, Record<string, unknown>>;
      resources.rooms.futureField = true;
    }],
    ["page", (value: Record<string, unknown>) => {
      (value.pages as Array<Record<string, unknown>>)[0].futureField = true;
    }],
    ["parameter", (value: Record<string, unknown>) => {
      const page = (value.pages as Array<Record<string, unknown>>)[0];
      (page.parameters as Array<Record<string, unknown>>)[0].futureField = true;
    }],
    ["mutation", (value: Record<string, unknown>) => {
      (value.mutations as Array<Record<string, unknown>>)[0].futureField = true;
    }]
  ])("keeps the schema/2 %s shape closed", (_label, mutate) => {
    const fixture = readFixture("fluxfast-schema-v2.json");
    mutate(fixture);

    expect(() => validateFluxFastSchemaManifest(fixture)).toThrow(
      /futureField: is not a supported field/
    );
  });
});
