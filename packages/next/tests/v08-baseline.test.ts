import { describe, expect, it } from "vitest";
import { compileFluxFastResourceTypes } from "../src/schema-compiler";
import {
  FLUXFAST_SCHEMA_MANIFEST_VERSION,
  validateFluxFastSchemaManifest,
} from "../src/schema-manifest";

describe("v0.7 developer-contract baseline", () => {
  it("continues to parse schema/1 and generate resource imports", () => {
    const manifest = {
      schema: FLUXFAST_SCHEMA_MANIFEST_VERSION,
      producer: "0.7.0",
      fingerprint: "a".repeat(64),
      resources: {
        rooms: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "integer" } },
              required: ["id"],
            },
          },
        },
      },
      pages: [],
      mutations: [],
    };

    expect(validateFluxFastSchemaManifest(manifest)).toBe(manifest);
    expect(compileFluxFastResourceTypes(manifest)).toContain(
      'rooms: "rooms",',
    );
    expect(compileFluxFastResourceTypes(manifest)).toContain(
      "export type RoomsResource = { id: number; }[];",
    );
  });
});
