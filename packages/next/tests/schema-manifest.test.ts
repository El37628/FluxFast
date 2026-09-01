import { describe, expect, it } from "vitest";
import {
  FLUXFAST_SCHEMA_MANIFEST_VERSION,
  parseFluxFastSchemaManifest,
  SchemaManifestValidationError,
  validateFluxFastSchemaManifest
} from "../src/schema-manifest";

const fingerprint = "a".repeat(64);

function validManifest(): Record<string, unknown> {
  return {
    schema: FLUXFAST_SCHEMA_MANIFEST_VERSION,
    producer: "0.6.0",
    fingerprint,
    resources: {
      rooms: {
        schema: {
          $defs: {
            Room: {
              type: "object",
              properties: { id: { type: "integer" } },
              required: ["id"]
            }
          },
          type: "array",
          items: { $ref: "#/$defs/Room" }
        }
      }
    },
    pages: [
      {
        name: "hotel_rooms",
        path: "/hotels/{hotel_id}/rooms",
        parameters: [
          {
            name: "hotel_id",
            location: "path",
            required: true,
            schema: { type: "integer" }
          },
          {
            name: "status",
            location: "query",
            required: false,
            schema: { anyOf: [{ type: "string" }, { type: "null" }] }
          }
        ]
      }
    ],
    mutations: [
      {
        name: "update_room",
        path: "/rooms/{room_id}",
        method: "PATCH",
        parameters: [
          {
            name: "room_id",
            location: "path",
            required: true,
            schema: { type: "integer" }
          }
        ],
        body: {
          type: "object",
          properties: { status: { enum: ["available", "occupied"] } },
          required: ["status"]
        }
      }
    ]
  };
}

function expectInvalid(
  mutate: (manifest: Record<string, unknown>) => void,
  message: RegExp
): void {
  const manifest = validManifest();
  mutate(manifest);
  expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(message);
}

describe("FluxFast schema manifest validation", () => {
  it("accepts the complete versioned developer manifest", () => {
    const manifest = validManifest();

    expect(validateFluxFastSchemaManifest(manifest)).toBe(manifest);
    expect(parseFluxFastSchemaManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("accepts recursive schemas without dereferencing them", () => {
    const manifest = validManifest();
    manifest.resources = {
      tree: {
        schema: {
          $defs: {
            Node: {
              type: "object",
              properties: {
                children: {
                  type: "array",
                  items: { $ref: "#/$defs/Node" }
                }
              }
            }
          },
          $ref: "#/$defs/Node"
        }
      }
    };

    expect(validateFluxFastSchemaManifest(manifest)).toBe(manifest);
  });

  it("reports malformed JSON clearly", () => {
    expect(() => parseFluxFastSchemaManifest("{"))
      .toThrow(/Invalid schema manifest at \$: must be valid JSON/);
  });

  it("uses a dedicated validation error with the failing manifest path", () => {
    try {
      validateFluxFastSchemaManifest({});
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaManifestValidationError);
      expect((error as SchemaManifestValidationError).path).toBe("$.schema");
    }
  });

  it("rejects unknown schema versions", () => {
    expectInvalid(
      manifest => {
        manifest.schema = "fluxfast-schema/2";
      },
      /at \$\.schema: unsupported version "fluxfast-schema\/2"/
    );
  });

  it("rejects invalid producers, fingerprints, and unknown top-level fields", () => {
    expectInvalid(
      manifest => {
        manifest.producer = "development";
      },
      /at \$\.producer: must use semantic version format/
    );
    expectInvalid(
      manifest => {
        manifest.fingerprint = "ABC";
      },
      /at \$\.fingerprint: must be a lowercase SHA-256 digest/
    );
    expectInvalid(
      manifest => {
        manifest.secret = "must-not-be-accepted";
      },
      /at \$\.secret: is not a supported field/
    );
  });

  it("rejects unsafe resource keys and malformed resource entries", () => {
    expectInvalid(
      manifest => {
        manifest.resources = { "rooms,users": { schema: {} } };
      },
      /must not contain commas or control characters/
    );
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: [], value: "secret" } };
      },
      /at \$\.resources\.rooms\.value: is not a supported field/
    );
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: [] } };
      },
      /at \$\.resources\.rooms\.schema: must be an object/
    );
  });

  it("rejects non-JSON and cyclic schema values without recursive traversal", () => {
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: { minimum: Number.NaN } } };
      },
      /must not contain a non-finite number/
    );

    const recursive: Record<string, unknown> = {};
    recursive.self = recursive;
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: recursive } };
      },
      /must not contain circular or shared object references/
    );
  });

  it("rejects malformed JSON Schema keywords", () => {
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: { type: "record" } } };
      },
      /at \$\.resources\.rooms\.schema\.type: must be a valid JSON Schema type/
    );
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: { $ref: 42 } } };
      },
      /at \$\.resources\.rooms\.schema\.\$ref: must be a string/
    );
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: { properties: [] } } };
      },
      /at \$\.resources\.rooms\.schema\.properties: must be an object/
    );
    expectInvalid(
      manifest => {
        manifest.resources = { rooms: { schema: { anyOf: [] } } };
      },
      /at \$\.resources\.rooms\.schema\.anyOf: must be a non-empty array of schemas/
    );
  });

  it("validates page descriptors and route parameters", () => {
    expectInvalid(
      manifest => {
        const pages = manifest.pages as Array<Record<string, unknown>>;
        pages[0].path = "hotels";
      },
      /at \$\.pages\[0\]\.path: must start with '\/'/
    );
    expectInvalid(
      manifest => {
        const pages = manifest.pages as Array<Record<string, unknown>>;
        const parameters = pages[0].parameters as Array<Record<string, unknown>>;
        parameters[0].required = false;
      },
      /must be true for path parameters/
    );
    expectInvalid(
      manifest => {
        const pages = manifest.pages as Array<Record<string, unknown>>;
        const parameters = pages[0].parameters as Array<Record<string, unknown>>;
        parameters.push({ ...parameters[0] });
      },
      /duplicates the path parameter "hotel_id"/
    );
  });

  it("validates mutation methods and JSON body schemas", () => {
    expectInvalid(
      manifest => {
        const mutations = manifest.mutations as Array<Record<string, unknown>>;
        mutations[0].method = "GET";
      },
      /must be one of "DELETE", "PATCH", "POST", or "PUT"/
    );
    expectInvalid(
      manifest => {
        const mutations = manifest.mutations as Array<Record<string, unknown>>;
        mutations[0].body = "not-a-schema";
      },
      /at \$\.mutations\[0\]\.body: must be an object/
    );
  });
});
