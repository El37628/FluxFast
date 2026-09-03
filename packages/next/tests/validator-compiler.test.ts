import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createValidator } from "@fluxfast/core";
import {
  compileFluxFastValidators,
  compileJsonSchemaToValidationPlan
} from "../src/validator-compiler";

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
});
