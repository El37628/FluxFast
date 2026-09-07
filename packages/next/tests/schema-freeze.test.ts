import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileFluxFastMutations } from "../src/mutation-compiler";
import { compileFluxFastPageRoutes } from "../src/route-compiler";
import { compileFluxFastResourceTypes } from "../src/schema-compiler";
import {
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
    const source = fs.readFileSync(
      path.join(fixtureRoot, "fluxfast-schema-v2.json"),
      "utf8"
    );
    const manifest = parseFluxFastSchemaManifest(source);

    expect(manifest.schema).toBe("fluxfast-schema/2");
    expect(manifest.fingerprint).toBe(
      "541a688a1f3aff53317ebdb67b10aa808479b70529f7d706b5bc9b96a2069a77"
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
