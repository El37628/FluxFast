import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLUXFAST_SCHEMA_MANIFEST_V2,
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

function totalStringLength(value: unknown): number {
  let total = 0;
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      total += item.length;
    } else if (Array.isArray(item)) {
      pending.push(...item);
    } else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        total += key.length;
        pending.push(child);
      }
    }
  }
  return total;
}

describe("FluxFast schema manifest validation", () => {
  it("accepts the complete versioned developer manifest", () => {
    const manifest = validManifest();

    expect(validateFluxFastSchemaManifest(manifest)).toEqual(manifest);
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

    expect(validateFluxFastSchemaManifest(manifest)).toEqual(manifest);
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
        manifest.schema = "fluxfast-schema/3";
      },
      /at \$\.schema: unsupported version "fluxfast-schema\/3"/
    );
  });

  it("accepts schema/2 with explicitly registered application types", () => {
    const manifest = validManifest();
    manifest.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
    manifest.types = {
      User: {
        mode: "serialization",
        schema: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"]
        }
      }
    };

    expect(validateFluxFastSchemaManifest(manifest)).toEqual(manifest);
  });

  it("requires types for schema/2 and rejects them for schema/1", () => {
    const withoutTypes = validManifest();
    withoutTypes.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
    expect(() => validateFluxFastSchemaManifest(withoutTypes)).toThrow(
      /at \$\.types: is required for fluxfast-schema\/2/
    );

    const withTypes = validManifest();
    withTypes.types = {};
    expect(() => validateFluxFastSchemaManifest(withTypes)).toThrow(
      /at \$\.types: fluxfast-schema\/1 cannot contain explicit type contracts/
    );
  });

  it("validates contract names, modes, and schemas", () => {
    const manifest = validManifest();
    manifest.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
    manifest.types = {
      "bad\nname": { mode: "serialization", schema: {} }
    };
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /at \$\.types\["bad\\nname"\]: must not contain control characters/
    );

    manifest.types = { User: { mode: "both", schema: {} } };
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /at \$\.types\.User\.mode: must be either/
    );

    manifest.types = { User: { mode: "validation", schema: [] } };
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /at \$\.types\.User\.schema: must be an object/
    );
  });

  it.each(["bad\u0000name", "bad\u007fname", "bad\u0085name"])(
    "rejects the complete control-character range in metadata: %j",
    name => {
      const manifest = validManifest();
      manifest.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
      manifest.types = { [name]: { mode: "validation", schema: {} } };
      expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
        /must not contain control characters/
      );
    }
  );

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

  it.each([
    ["type", (manifest: Record<string, unknown>) => {
      manifest.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
      manifest.types = { User: { mode: "validation", schema: {}, secret: true } };
    }],
    ["page", (manifest: Record<string, unknown>) => {
      (manifest.pages as Array<Record<string, unknown>>)[0].secret = true;
    }],
    ["parameter", (manifest: Record<string, unknown>) => {
      const page = (manifest.pages as Array<Record<string, unknown>>)[0];
      (page.parameters as Array<Record<string, unknown>>)[0].secret = true;
    }],
    ["mutation", (manifest: Record<string, unknown>) => {
      (manifest.mutations as Array<Record<string, unknown>>)[0].secret = true;
    }]
  ])("rejects unexpected %s fields", (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /secret: is not a supported field/
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
      /must not contain circular (?:or shared )?object references/
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite schema number %s",
    number => {
      expectInvalid(
        manifest => {
          manifest.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
          manifest.types = {
            Unsafe: { mode: "validation", schema: { minimum: number } }
          };
        },
        /must not contain a non-finite number/
      );
    }
  );

  it.each([
    { const: Number.MAX_SAFE_INTEGER + 1 },
    { enum: [Number.MIN_SAFE_INTEGER - 1] },
    { minimum: Number.MAX_VALUE }
  ])("rejects schema integers JavaScript cannot represent safely: %j", schema => {
    expectInvalid(
      manifest => {
        manifest.resources = { unsafe: { schema } };
      },
      /integer outside the JavaScript safe integer range/
    );
  });

  it("accepts JavaScript safe integer boundaries", () => {
    const manifest = validManifest();
    manifest.resources = {
      safe: {
        schema: {
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER
        }
      }
    };
    expect(validateFluxFastSchemaManifest(manifest)).toBeDefined();
  });

  it("parses the shared Python manifest boundary fixture", () => {
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../tests/fixtures/python-manifest-boundaries.json"
      ),
      "utf8"
    );
    const manifest = parseFluxFastSchemaManifest(source);
    const typeName = Object.keys(manifest.types!)[0];

    expect(typeName.length).toBe(128);
    expect(manifest.types![typeName].schema.minimum).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it("bounds the complete manifest source before JSON parsing", () => {
    const oversizedWhitespace = " ".repeat(8 * 1024 * 1024 + 1);
    expect(() => parseFluxFastSchemaManifest(oversizedWhitespace)).toThrow(
      /source must not exceed 8388608 characters/
    );

    const duplicateKeys = `{${
      '"padding":0,'.repeat(700_000)
    }"schema":"fluxfast-schema/1","producer":"0.8.0","fingerprint":"${fingerprint}","resources":{},"pages":[],"mutations":[]}`;
    expect(() => parseFluxFastSchemaManifest(duplicateKeys)).toThrow(
      /source must not exceed 8388608 characters/
    );
  });

  it.each([
    ["types", (manifest: Record<string, unknown>) => {
      manifest.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
      manifest.types = Object.fromEntries(
        Array.from({ length: 10_001 }, (_, index) => [
          `Type${index}`,
          { mode: "validation", schema: {} }
        ])
      );
    }],
    ["resources", (manifest: Record<string, unknown>) => {
      manifest.resources = Object.fromEntries(
        Array.from({ length: 10_001 }, (_, index) => [
          `resource-${index}`,
          { schema: {} }
        ])
      );
    }],
    ["pages", (manifest: Record<string, unknown>) => {
      manifest.pages = Array.from({ length: 10_001 }, (_, index) => ({
        name: `page-${index}`,
        path: `/page-${index}`,
        parameters: []
      }));
    }],
    ["mutations", (manifest: Record<string, unknown>) => {
      manifest.mutations = Array.from({ length: 10_001 }, (_, index) => ({
        name: `mutation-${index}`,
        path: `/mutation-${index}`,
        method: "POST",
        parameters: []
      }));
    }],
    ["parameters", (manifest: Record<string, unknown>) => {
      manifest.pages = [{
        name: "many_parameters",
        path: "/many-parameters",
        parameters: Array.from({ length: 10_001 }, (_, index) => ({
          name: `parameter-${index}`,
          location: "query",
          required: false,
          schema: {}
        }))
      }];
    }]
  ])("bounds excessive %s collections", (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /more than 10000 (?:entries|properties)/
    );
  });

  it("bounds aggregate metadata even when each field is valid in isolation", () => {
    const manifest = validManifest();
    const name = "n".repeat(128);
    const route = `/${"p".repeat(2047)}`;
    manifest.pages = Array.from({ length: 4_100 }, () => ({
      name,
      path: route,
      parameters: []
    }));

    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /more than 8388608 total string characters/
    );
  });

  it("enforces the exact whole-manifest value boundary", () => {
    const manifest: Record<string, unknown> = {
      schema: FLUXFAST_SCHEMA_MANIFEST_VERSION,
      producer: "0.8.0",
      fingerprint,
      resources: {},
      pages: [],
      mutations: []
    };
    const metadata = Array.from(
      { length: 10 },
      (_, index) => Array(index === 9 ? 9_980 : 10_000).fill(null)
    );
    manifest.resources = { bounded: { schema: { metadata } } };

    expect(validateFluxFastSchemaManifest(manifest)).toBeDefined();
    metadata[9].push(null);
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /more than 100000 JSON values/
    );
  });

  it("enforces the exact aggregate string boundary", () => {
    const manifest = validManifest();
    const metadata: string[] = [];
    manifest.resources = { bounded: { schema: { metadata } } };
    let remaining = 8 * 1024 * 1024 - totalStringLength(manifest);
    while (remaining > 0) {
      const length = Math.min(65_536, remaining);
      metadata.push("x".repeat(length));
      remaining -= length;
    }

    expect(totalStringLength(manifest)).toBe(8 * 1024 * 1024);
    expect(validateFluxFastSchemaManifest(manifest)).toBeDefined();
    metadata.push("x");
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /more than 8388608 total string characters/
    );
  });

  it("counts shared aliases as repeated serialized contributions", () => {
    const manifest = validManifest();
    const sharedSchema = { description: "x".repeat(60_000) };
    manifest.resources = Object.fromEntries(
      Array.from({ length: 140 }, (_, index) => [
        `resource-${index}`,
        { schema: sharedSchema }
      ])
    );

    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /more than 8388608 total string characters/
    );
  });

  it.each(["\u0000", "\u007f", "\u0085"])(
    "rejects control character %j across every metadata and route field",
    control => {
      const mutations: Array<(manifest: Record<string, unknown>) => void> = [
        manifest => {
          manifest.resources = { [`rooms${control}`]: { schema: {} } };
        },
        manifest => {
          (manifest.pages as Array<Record<string, unknown>>)[0].name =
            `rooms${control}`;
        },
        manifest => {
          (manifest.pages as Array<Record<string, unknown>>)[0].path =
            `/rooms${control}`;
        },
        manifest => {
          const page = (manifest.pages as Array<Record<string, unknown>>)[0];
          (page.parameters as Array<Record<string, unknown>>)[0].name =
            `room${control}id`;
        },
        manifest => {
          (manifest.mutations as Array<Record<string, unknown>>)[0].name =
            `update${control}room`;
        },
        manifest => {
          (manifest.mutations as Array<Record<string, unknown>>)[0].path =
            `/rooms${control}`;
        },
        manifest => {
          const mutation = (
            manifest.mutations as Array<Record<string, unknown>>
          )[0];
          (mutation.parameters as Array<Record<string, unknown>>)[0].name =
            `room${control}id`;
        }
      ];

      for (const mutate of mutations) {
        const manifest = validManifest();
        mutate(manifest);
        expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
          /control characters/
        );
      }
    }
  );

  it("rejects hostile direct values with stable manifest errors", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => validateFluxFastSchemaManifest(revoked.proxy)).toThrow(
      SchemaManifestValidationError
    );

    const accessor = validManifest();
    Object.defineProperty(accessor, "producer", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      }
    });
    expect(() => validateFluxFastSchemaManifest(accessor)).toThrow(
      /must not use an accessor property/
    );
  });

  it.each(["schema", "producer", "fingerprint", "resources", "pages", "mutations"])(
    "rejects a hidden %s accessor without invoking it",
    field => {
      const manifest = validManifest();
      const original = manifest[field];
      let calls = 0;
      Object.defineProperty(manifest, field, {
        enumerable: false,
        get() {
          calls += 1;
          return original;
        }
      });

      expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
        /must not use an accessor property/
      );
      expect(calls).toBe(0);
    }
  );

  it.each([
    ["type entry", (manifest: Record<string, unknown>, getter: () => unknown) => {
      manifest.schema = FLUXFAST_SCHEMA_MANIFEST_V2;
      manifest.types = { User: { mode: "validation", schema: {} } };
      Object.defineProperty(
        (manifest.types as Record<string, Record<string, unknown>>).User,
        "mode",
        { enumerable: true, get: getter }
      );
    }],
    ["resource entry", (manifest: Record<string, unknown>, getter: () => unknown) => {
      Object.defineProperty(
        (manifest.resources as Record<string, Record<string, unknown>>).rooms,
        "schema",
        { enumerable: true, get: getter }
      );
    }],
    ["page", (manifest: Record<string, unknown>, getter: () => unknown) => {
      Object.defineProperty(
        (manifest.pages as Array<Record<string, unknown>>)[0],
        "name",
        { enumerable: true, get: getter }
      );
    }],
    ["mutation", (manifest: Record<string, unknown>, getter: () => unknown) => {
      Object.defineProperty(
        (manifest.mutations as Array<Record<string, unknown>>)[0],
        "method",
        { enumerable: true, get: getter }
      );
    }],
    ["parameter", (manifest: Record<string, unknown>, getter: () => unknown) => {
      const page = (manifest.pages as Array<Record<string, unknown>>)[0];
      Object.defineProperty(
        (page.parameters as Array<Record<string, unknown>>)[0],
        "required",
        { enumerable: true, get: getter }
      );
    }],
    ["schema", (manifest: Record<string, unknown>, getter: () => unknown) => {
      const resources = manifest.resources as Record<
        string,
        { schema: Record<string, unknown> }
      >;
      Object.defineProperty(resources.rooms.schema, "type", {
        enumerable: true,
        get: getter
      });
    }]
  ])("rejects a nested %s accessor without invoking it", (_label, mutate) => {
    const manifest = validManifest();
    let calls = 0;
    mutate(manifest, () => {
      calls += 1;
      return "unsafe";
    });
    expect(() => validateFluxFastSchemaManifest(manifest)).toThrow(
      /must not use an accessor property/
    );
    expect(calls).toBe(0);
  });

  it("rejects hidden data and symbol properties as non-JSON-compatible", () => {
    const hidden = validManifest();
    Object.defineProperty(hidden, "hidden", {
      enumerable: false,
      value: "secret"
    });
    expect(() => validateFluxFastSchemaManifest(hidden)).toThrow(
      /must be an enumerable JSON property/
    );

    const symbol = validManifest();
    Object.defineProperty(symbol, Symbol("secret"), {
      enumerable: true,
      value: "secret"
    });
    expect(() => validateFluxFastSchemaManifest(symbol)).toThrow(
      /must not contain symbol properties/
    );
  });

  it("validates a descriptor snapshot without invoking later proxy reads", () => {
    let getCalls = 0;
    const proxy = new Proxy(validManifest(), {
      get() {
        getCalls += 1;
        throw new Error("stateful get trap");
      }
    });

    expect(validateFluxFastSchemaManifest(proxy)).toEqual(validManifest());
    expect(getCalls).toBe(0);
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
