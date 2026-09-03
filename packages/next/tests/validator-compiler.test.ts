import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createValidator } from "@fluxfast/core";
import {
  compileFluxFastValidators,
  compileFluxFastValidatorsWithDiagnostics,
  compileJsonSchemaToValidationPlan
} from "../src/validator-compiler";
import { compileFluxFastTypes } from "../src/schema-compiler";

const fingerprint = "f".repeat(64);

function manifest(
  resources: Record<string, { schema: Record<string, unknown> }> = {},
  mutations: unknown[] = [],
  types?: Record<
    string,
    { mode: "serialization" | "validation"; schema: Record<string, unknown> }
  >
) {
  return {
    schema: types ? "fluxfast-schema/2" : "fluxfast-schema/1",
    producer: "0.8.0",
    fingerprint,
    ...(types ? { types } : {}),
    resources,
    pages: [],
    mutations
  };
}

function typeSource(): string {
  return (
    "export interface User {\n" +
    "  id: number;\n" +
    "  email: string;\n" +
    "}\n" +
    "export interface CreateUserBody {\n" +
    "  email: string;\n" +
    "}\n" +
    "export type RoomsResource = User[];\n"
  );
}

function compileTypeScript(source: string, types = typeSource()): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-validator-"));
  const sourceFile = path.join(directory, "validators.generated.ts");
  const typesFile = path.join(directory, "types.generated.ts");
  const configFile = path.join(directory, "tsconfig.json");
  fs.writeFileSync(sourceFile, source, "utf8");
  fs.writeFileSync(typesFile, types, "utf8");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: [],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        paths: {
          "@fluxfast/core": [
            path.resolve(__dirname, "../../core/src/index.ts")
          ]
        }
      },
      files: [sourceFile, typesFile]
    }, null, 2) + "\n",
    "utf8"
  );
  try {
    const result = spawnSync(
      path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
      ["--project", configFile],
      { encoding: "utf8" }
    );
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

interface ValidationPatternCases {
  accepted: Array<{ pattern: string; valid: string; invalid: string }>;
  rejected: string[];
}

const validationPatternCases = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../../tests/fixtures/validation-pattern-cases.json"),
    "utf8"
  )
) as ValidationPatternCases;

describe("FluxFast validator compiler", () => {
  it("emits typed validators for explicit, resource, and mutation contracts", () => {
    const output = compileFluxFastValidators(
      manifest(
        {
          rooms: {
            schema: {
              type: "array",
              items: {
                $ref: "#/$defs/User"
              },
              $defs: {
                User: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    email: { type: "string", format: "email" }
                  },
                  required: ["id", "email"]
                }
              }
            }
          }
        },
        [
          {
            name: "create_user",
            path: "/users",
            method: "POST",
            parameters: [],
            body: {
              type: "object",
              properties: {
                email: { type: "string", minLength: 3 }
              },
              required: ["email"]
            }
          }
        ],
        {
          User: {
            mode: "serialization",
            schema: {
              type: "object",
              properties: {
                id: { type: "integer" },
                email: { type: "string", format: "email" }
              },
              required: ["id", "email"]
            }
          }
        }
      )
    );

    expect(output).toContain("export const UserValidator");
    expect(output).toContain("export const RoomsResourceValidator");
    expect(output).toContain("export const CreateUserBodyValidator");
    expect(output).toContain("createValidator<User>");
    expect(output).toContain('"format": "email"');
    expect(output).toContain("export const validators");
    compileTypeScript(output);
  });

  it("preserves recursive references and constraints in the generated plan", () => {
    const output = compileFluxFastValidators(
      manifest({}, [], {
        TreeNode: {
          mode: "serialization",
          schema: {
            $defs: {
              TreeNode: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1 },
                  children: {
                    type: "array",
                    items: { $ref: "#/$defs/TreeNode" }
                  }
                },
                required: ["name", "children"]
              }
            },
            $ref: "#/$defs/TreeNode"
          }
        }
      })
    );

    expect(output).toContain('"ref": "#/$defs/TreeNode"');
    expect(output).toContain('"minLength": 1');
    compileTypeScript(
      output,
      "export interface TreeNode {\n" +
      "  name: string;\n" +
      "  children: TreeNode[];\n" +
      "}\n"
    );
  });

  it("produces plans accepted by the framework-neutral runtime", () => {
    const plan = compileJsonSchemaToValidationPlan({
      $defs: {
        Address: {
          type: "object",
          properties: {
            city: { type: "string", minLength: 2 }
          },
          required: ["city"]
        }
      },
      type: "object",
      properties: {
        address: { $ref: "#/$defs/Address" },
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1
        }
      },
      required: ["address", "tags"]
    });
    const validator = createValidator<{
      address: { city: string };
      tags: string[];
    }>(plan);

    expect(
      validator.validate({
        address: { city: "KL" },
        tags: ["flux"]
      })
    ).toMatchObject({ valid: true });
    const invalid = validator.validate({
      address: { city: "K" },
      tags: []
    });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.issues.map(issue => issue.path)).toEqual([
        ["address", "city"],
        ["tags"]
      ]);
    }
  });

  it("rejects unsupported validation keywords instead of dropping them", () => {
    expect(() =>
      compileFluxFastValidators(
        manifest({}, [], {
          Tags: {
            mode: "validation",
            schema: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true
            }
          }
        })
      )
    ).toThrow(/unsupported validation keyword "uniqueItems"/);
  });

  it("reports unsupported contracts without blocking other generated output", () => {
    const result = compileFluxFastValidatorsWithDiagnostics(
      manifest(
        {
          rooms: {
            schema: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true
            }
          },
          users: {
            schema: {
              type: "array",
              items: { type: "integer" }
            }
          }
        },
        [],
        {
          User: {
            mode: "validation",
            schema: { type: "string", minLength: 2 }
          }
        }
      )
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        contract: "RoomsResource",
        keyword: "uniqueItems",
        path: "$.resources.rooms.schema.uniqueItems"
      })
    ]);
    expect(result.contracts).toEqual(["User", "UsersResource"]);
    expect(result.content).toContain("UsersResourceValidator");
    expect(result.content).toContain("UserValidator");
    expect(result.content).not.toContain("RoomsResourceValidator");
    expect(result.content).toContain("validatorDiagnostics");
    compileTypeScript(
      result.content,
      "export type User = string;\n" +
        "export type UsersResource = number[];\n"
    );
  });

  it("rejects typeless constraints instead of compiling them as any", () => {
    for (const schema of [
      { pattern: "^a+$" },
      { minimum: 5 },
      {
        $defs: { Value: { type: "string" } },
        $ref: "#/$defs/Value",
        minLength: 3
      }
    ]) {
      expect(() => compileJsonSchemaToValidationPlan(schema)).toThrow(
        /requires an explicit JSON Schema type; refusing to drop its semantics/
      );
    }
  });

  it("reports regex syntax and backtracking patterns as unsupported contracts", () => {
    const result = compileFluxFastValidatorsWithDiagnostics(
      manifest(
        {
          unsafe: {
            schema: {
              type: "string",
              pattern: "(?P<word>a+)"
            }
          },
          backtracking: {
            schema: {
              type: "string",
              pattern: "^a{1,3}b{1,3}$"
            }
          },
          safe: {
            schema: {
              type: "string",
              pattern: "^item-[0-9]+$"
            }
          }
        }
      )
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        contract: "BacktrackingResource",
        keyword: "pattern",
        path: "$.resources.backtracking.schema.pattern"
      }),
      expect.objectContaining({
        contract: "UnsafeResource",
        keyword: "pattern",
        path: "$.resources.unsafe.schema.pattern"
      })
    ]);
    expect(result.content).toContain("SafeResourceValidator");
    expect(result.content).not.toContain("UnsafeResourceValidator");
    expect(result.content).not.toContain("BacktrackingResourceValidator");
  });

  it("rejects schemas that exceed compiler traversal bounds", () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 65; depth += 1) {
      nested = { type: "array", items: nested };
    }

    expect(() => compileJsonSchemaToValidationPlan(nested)).toThrow(
      /schema nesting exceeds the maximum/
    );
  });

  it("keeps compiler and runtime behavior aligned with the shared pattern table", () => {
    for (const testCase of validationPatternCases.accepted) {
      const validator = createValidator(
        compileJsonSchemaToValidationPlan({
          type: "string",
          pattern: testCase.pattern
        })
      );
      expect(validator.is(testCase.valid), testCase.pattern).toBe(true);
      expect(validator.is(testCase.invalid), testCase.pattern).toBe(false);
    }
    for (const pattern of validationPatternCases.rejected) {
      expect(
        () => compileJsonSchemaToValidationPlan({ type: "string", pattern }),
        pattern
      ).toThrow();
    }
    expect(() => compileJsonSchemaToValidationPlan({
      type: "string",
      pattern: "a".repeat(8_193)
    })).toThrow(/pattern is too long/);
  });

  it("bounds deeply nested literal values before recursive rendering", () => {
    let literal: unknown = "leaf";
    for (let depth = 0; depth < 65; depth += 1) {
      literal = { value: literal };
    }

    expect(() =>
      compileJsonSchemaToValidationPlan({ const: literal } as Record<string, unknown>)
    ).toThrow(/schema value nesting exceeds the maximum/);

    expect(() =>
      compileFluxFastValidators(
        manifest({
          deeplyNested: { schema: { const: literal } }
        })
      )
    ).toThrow(/(?:schema value nesting exceeds the maximum|must not exceed a nesting depth)/);

    expect(() =>
      compileFluxFastTypes(
        manifest({}, [], {
          DeepLiteral: {
            mode: "serialization",
            schema: { const: literal }
          }
        })
      )
      ).toThrow(/(?:schema value nesting exceeds the maximum|must not exceed a nesting depth)/);
  });

  it("enforces aggregate schema-value and scalar-length limits", () => {
    const values = Array.from({ length: 1_000 }, () =>
      Array.from({ length: 100 }, (_, index) => index)
    );
    expect(() =>
      compileJsonSchemaToValidationPlan({
        type: "array",
        enum: values
      } as Record<string, unknown>)
    ).toThrow(/schema contains more than 100000 JSON values/);

    expect(() =>
      compileJsonSchemaToValidationPlan({
        type: "string",
        const: "x".repeat(65_537)
      } as Record<string, unknown>)
    ).toThrow(/strings longer than 65536 characters/);
  });

  it("shares the schema-value budget across manifest contracts", () => {
    const resources = Object.fromEntries(
      Array.from({ length: 50 }, (_, resourceIndex) => [
        `resource-${resourceIndex}`,
        {
          schema: {
            type: "array",
            enum: Array.from({ length: 2_000 }, (_, value) => value)
          }
        }
      ])
    );

    expect(() => compileFluxFastValidators(manifest(resources))).toThrow(
      /must not contain more than 100000 JSON values/
    );
  });

  it("supports schema/1 and remains byte-for-byte deterministic", () => {
    const input = manifest(
      {
        rooms: {
          schema: {
            type: "array",
            items: { type: "integer", minimum: 1 }
          }
        }
      },
      [
        {
          name: "create_room",
          path: "/rooms",
          method: "POST",
          parameters: [],
          body: {
            type: "object",
            properties: { number: { type: "string" } },
            required: ["number"]
          }
        }
      ]
    );
    const first = compileFluxFastValidators(input);
    const second = compileFluxFastValidators(JSON.parse(JSON.stringify(input)));
    expect(first).toBe(second);
    expect(first).toContain("// Schema: fluxfast-schema/1");
    expect(first).toContain("RoomsResourceValidator");
    expect(first).toContain("CreateRoomBodyValidator");
  });

  it("renders prototype-sensitive property maps without a prototype setter", () => {
    const properties: Record<string, unknown> = Object.create(null);
    properties.__proto__ = { type: "string" };
    properties.constructor = { type: "string" };
    const output = compileFluxFastValidators(
      manifest({}, [], {
        Dangerous: {
          mode: "validation",
          schema: {
            type: "object",
            properties,
            required: ["__proto__", "constructor"]
          }
        }
      })
    );
    expect(output).toContain("Object.fromEntries");
    compileTypeScript(
      output,
      "export interface Dangerous {\n" +
      "  __proto__: string;\n" +
      "  constructor: string;\n" +
      "}\n"
    );
  });

  it("executes escaped and prototype-sensitive references safely", () => {
    const schema = JSON.parse(`{
      "$defs": {
        "__proto__": { "type": "string" },
        "constructor": { "type": "integer" },
        "prototype": { "type": "boolean" },
        "a/b": { "type": "string", "pattern": "^safe$" },
        "a~b": { "type": "number", "minimum": 1 }
      },
      "type": "object",
      "properties": {
        "__proto__": { "$ref": "#/$defs/__proto__" },
        "constructor": { "$ref": "#/$defs/constructor" },
        "prototype": { "$ref": "#/$defs/prototype" },
        "slash": { "$ref": "#/$defs/a~1b" },
        "slashPercent": { "$ref": "#/$defs/a%7E1b" },
        "tilde": { "$ref": "#/$defs/a~0b" }
      },
      "required": ["__proto__", "constructor", "prototype", "slash", "slashPercent", "tilde"],
      "additionalProperties": false
    }`);
    const validator = createValidator(
      compileJsonSchemaToValidationPlan(schema)
    );
    const value = JSON.parse(
      '{"__proto__":"safe","constructor":1,"prototype":true,"slash":"safe","slashPercent":"safe","tilde":2}'
    );

    expect(validator.is(value)).toBe(true);
    expect(validator.is({ ...value, slash: "unsafe" })).toBe(false);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it.each([
    ["#/$defs/%ZZ", /invalid URI escaping/],
    ["#/$defs/a%2Fb", /must point directly to a local definition/],
    ["#/$defs/a~2b", /invalid JSON Pointer escaping/],
    ["#/$defs/", /must point directly to a local definition/],
    ["#/$defs/a/b", /must point directly to a local definition/],
    ["https://example.com/schema", /only local \$defs references are supported/],
    ["#/$defs/Missing", /unknown definition/]
  ])("rejects unsafe validator reference %s", (reference, message) => {
    expect(() => compileJsonSchemaToValidationPlan({ $ref: reference })).toThrow(
      message
    );
  });

  it("handles compatible and incompatible duplicate validator definitions", () => {
    const compatible = compileJsonSchemaToValidationPlan({
      $defs: { Shared: { type: "string" } },
      definitions: { Shared: { type: "string" } },
      $ref: "#/$defs/Shared"
    });
    expect(createValidator(compatible).is("safe")).toBe(true);

    expect(() => compileJsonSchemaToValidationPlan({
      $defs: { Shared: { type: "string" } },
      definitions: { Shared: { type: "number" } },
      $ref: "#/$defs/Shared"
    })).toThrow(/incompatible definition/);
  });
});
