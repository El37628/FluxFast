import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFluxFastResourceTypes } from "../src/schema-compiler";

const fingerprint = "b".repeat(64);

function manifest(resources: Record<string, { schema: Record<string, unknown> }>) {
  return {
    schema: "fluxfast-schema/1",
    producer: "0.6.0",
    fingerprint,
    resources,
    pages: [],
    mutations: []
  };
}

function schema2Manifest(
  types: Record<string, { mode: "serialization" | "validation"; schema: Record<string, unknown> }>,
  resources: Record<string, { schema: Record<string, unknown> }> = {},
  mutations: unknown[] = []
) {
  return {
    schema: "fluxfast-schema/2",
    producer: "0.8.0",
    fingerprint,
    types,
    resources,
    pages: [],
    mutations
  };
}

function expectValidTypeScript(source: string): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-types-"));
  const sourceFile = path.join(directory, "types.generated.ts");
  const configFile = path.join(directory, "tsconfig.json");
  fs.writeFileSync(sourceFile, source, "utf8");
  fs.writeFileSync(
    configFile,
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: [],
        strict: true,
        skipLibCheck: true,
        paths: {
          "@fluxfast/core": [
            path.resolve(__dirname, "../../core/src/index.ts")
          ]
        }
      },
      files: [sourceFile]
    }, null, 2)}\n`,
    "utf8"
  );
  try {
    const result = spawnSync(
      path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
      ["--noEmit", "--project", configFile],
      { encoding: "utf8" }
    );
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("FluxFast JSON Schema compiler", () => {
  it("emits explicitly registered application contracts in the shared type graph", () => {
    const output = compileFluxFastResourceTypes(
      schema2Manifest({
        User: {
          mode: "serialization",
          schema: {
            title: "ServerUserTitleMustNotOverrideExplicitName",
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        },
        CreateUserInput: {
          mode: "validation",
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"]
          }
        }
      })
    );

    expect(output).toContain("export interface User {");
    expect(output).toContain("export interface CreateUserInput {");
    expect(output).toContain("id: number;");
    expect(output).toContain("name: string;");
    expect(output).not.toContain("ServerUserTitleMustNotOverrideExplicitName");
  });

  it("emits reusable mutation body contracts and reuses compatible explicit types", () => {
    const body = {
      type: "object",
      properties: { number: { type: "string" } },
      required: ["number"]
    };
    const output = compileFluxFastResourceTypes(
      schema2Manifest(
        {
          CreateRoomBody: { mode: "validation", schema: body }
        },
        {},
        [
          {
            name: "create_room",
            path: "/rooms",
            method: "POST",
            parameters: [],
            body
          }
        ]
      )
    );

    expect(output.match(/export interface CreateRoomBody/g)).toHaveLength(1);
    expect(output).toContain("number: string;");
  });

  it("rejects an incompatible explicit type and mutation body collision", () => {
    expect(() =>
      compileFluxFastResourceTypes(
        schema2Manifest(
          {
            CreateRoomBody: { mode: "validation", schema: { type: "string" } }
          },
          {},
          [
            {
              name: "create_room",
              path: "/rooms",
              method: "POST",
              parameters: [],
              body: { type: "object", properties: {} }
            }
          ]
        )
      )
    ).toThrow(/model name CreateRoomBody collides with an incompatible definition/);
  });

  it("rejects normalized explicit-name collisions and incompatible graph definitions", () => {
    expect(() =>
      compileFluxFastResourceTypes(
        schema2Manifest({
          "user-profile": { mode: "serialization", schema: { type: "string" } },
          user_profile: { mode: "serialization", schema: { type: "number" } }
        })
      )
    ).toThrow(/collides .* as TypeScript name UserProfile/);

    expect(() =>
      compileFluxFastResourceTypes(
        schema2Manifest(
          { User: { mode: "serialization", schema: { type: "string" } } },
          {
            users: {
              schema: {
                $defs: {
                  User: { type: "number" }
                },
                type: "array",
                items: { $ref: "#/$defs/User" }
              }
            }
          }
        )
      )
    ).toThrow(/model name User collides with an incompatible definition/);
  });

  it("generates readable model, enum, array, optional, and formatted string types", () => {
    const output = compileFluxFastResourceTypes(
      manifest({
        rooms: {
          schema: {
            $defs: {
              Room: {
                title: "Room",
                type: "object",
                properties: {
                  createdAt: { type: "string", format: "date-time" },
                  id: { type: "integer" },
                  label: { type: "string" },
                  status: { $ref: "#/$defs/RoomStatus" }
                },
                required: ["id", "status"]
              },
              RoomStatus: {
                title: "RoomStatus",
                enum: ["available", "occupied"],
                type: "string"
              }
            },
            type: "array",
            items: { $ref: "#/$defs/Room" }
          }
        }
      })
    );

    expect(output).toBe(`// AUTO-GENERATED BY FLUXFAST.
// DO NOT EDIT MANUALLY.
// Schema: fluxfast-schema/1
// Producer: 0.6.0
// Fingerprint: ${fingerprint}

import type {} from "@fluxfast/core";

export const resourceKeys = {
  rooms: "rooms",
} as const;

export interface Room {
  createdAt?: string;
  id: number;
  label?: string;
  status: RoomStatus;
}

export type RoomStatus = "available" | "occupied";

export type RoomsResource = Room[];

export interface GeneratedFluxResourceMap {
  rooms: RoomsResource;
}

declare module "@fluxfast/core" {
  interface FluxResourceMap {
    rooms: RoomsResource;
  }
}
`);
    expectValidTypeScript(output);
  });

  it("supports records, unions, nullable values, constants, and unconstrained schemas", () => {
    const output = compileFluxFastResourceTypes(
      manifest({
        settings: {
          schema: {
            title: "Settings",
            type: "object",
            properties: {
              mode: { const: "safe" },
              note: { anyOf: [{ type: "string" }, { type: "null" }] },
              payload: {},
              value: { oneOf: [{ type: "number" }, { type: "boolean" }] }
            },
            required: ["mode", "note", "payload", "value"]
          }
        },
        totals: {
          schema: {
            type: "object",
            additionalProperties: { type: "number" }
          }
        }
      })
    );

    expect(output).toContain("export interface Settings {");
    expect(output).toContain('mode: "safe";');
    expect(output).toContain("note: string | null;");
    expect(output).toContain("payload: unknown;");
    expect(output).toContain("value: number | boolean;");
    expect(output).toContain("export type SettingsResource = Settings;");
    expect(output).toContain(
      "export type TotalsResource = { [key: string]: number; };"
    );
    expect(output).toContain("settings: SettingsResource;");
    expect(output).toContain("totals: TotalsResource;");
    expect(output).toContain(`export const resourceKeys = {
  settings: "settings",
  totals: "totals",
} as const;`);
    expect(output).not.toContain("any");
  });

  it("supports nested, recursive, and allOf references", () => {
    const output = compileFluxFastResourceTypes(
      manifest({
        trees: {
          schema: {
            $defs: {
              BaseNode: {
                title: "BaseNode",
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"]
              },
              Node: {
                title: "Node",
                allOf: [
                  { $ref: "#/$defs/BaseNode" },
                  {
                    type: "object",
                    properties: {
                      children: {
                        type: "array",
                        items: { $ref: "#/$defs/Node" }
                      }
                    },
                    required: ["children"]
                  }
                ]
              }
            },
            type: "array",
            items: { $ref: "#/$defs/Node" }
          }
        }
      })
    );

    expect(output).toContain("export interface BaseNode");
    expect(output).toContain(
      "export type Node = BaseNode & { children: Node[]; };"
    );
    expect(output).toContain("export type TreesResource = Node[];");
  });

  it("quotes unsafe property names and rejects unresolved or external references", () => {
    const output = compileFluxFastResourceTypes(
      manifest({
        values: {
          schema: {
            title: "Payload",
            type: "object",
            properties: {
              'value"; globalThis.compromised = true; "': { type: "string" }
            }
          }
        }
      })
    );
    expect(output).toContain(
      '"value\\\"; globalThis.compromised = true; \\\""?: string;'
    );
    expect(output).toContain("values: ValuesResource;");

    expect(() =>
      compileFluxFastResourceTypes(
        manifest({ broken: { schema: { $ref: "#/$defs/Missing" } } })
      )
    ).toThrow(/references unknown definition "Missing"/);
    expect(() =>
      compileFluxFastResourceTypes(
        manifest({ broken: { schema: { $ref: "https:\/\/example.com/schema" } } })
      )
    ).toThrow(/only local \$defs references are supported/);
  });

  it("generates safe camel-cased keys and rejects normalized collisions", () => {
    const output = compileFluxFastResourceTypes(
      manifest({
        "room-types": { schema: { type: "string" } },
        "unsafe key; globalThis.compromised = true": {
          schema: { type: "number" }
        }
      })
    );
    expect(output).toContain('roomTypes: "room-types",');
    expect(output).toMatch(
      /unsafeKeyGlobalThisCompromisedTrue: "unsafe key; globalThis\.compromised = true",/
    );
    expectValidTypeScript(output);

    expect(() =>
      compileFluxFastResourceTypes(
        manifest({
          "room-types": { schema: { type: "string" } },
          room_types: { schema: { type: "number" } }
        })
      )
    ).toThrow(/collides .* as TypeScript constant resourceKeys\.roomTypes/);
  });

  it("handles prototype-sensitive resource and definition names from JSON", () => {
    const input = JSON.parse(`{
      "schema": "fluxfast-schema/1",
      "producer": "0.6.0",
      "fingerprint": "${fingerprint}",
      "resources": {
        "__proto__": {
          "schema": {
            "$defs": {
              "__proto__": {
                "title": "SafeModel",
                "type": "object",
                "properties": { "constructor": { "type": "string" } },
                "required": ["constructor"]
              }
            },
            "type": "array",
            "items": { "$ref": "#/$defs/__proto__" }
          }
        }
      },
      "pages": [],
      "mutations": []
    }`);

    const output = compileFluxFastResourceTypes(input);
    expect(output).toContain('proto: "__proto__",');
    expect(output).toContain("export interface SafeModel");
    expect(output).toContain("constructor: string;");
    expect(output).toContain("export type ProtoResource = SafeModel[];");
    expectValidTypeScript(output);
  });

  it("is deterministic and rejects normalized model collisions", () => {
    const input = manifest({
      beta: { schema: { type: "boolean" } },
      alpha: { schema: { type: "string" } }
    });
    expect(compileFluxFastResourceTypes(input)).toBe(
      compileFluxFastResourceTypes(input)
    );
    expect(compileFluxFastResourceTypes(input)).toContain(
      "export type AlphaResource = string;\n\nexport type BetaResource = boolean;"
    );

    expect(() =>
      compileFluxFastResourceTypes(
        manifest({
          first: {
            schema: {
              $defs: {
                "room-type": { title: "RoomType", type: "string" },
                room_type: { title: "RoomType", type: "number" }
              },
              type: "string"
            }
          }
        })
      )
    ).toThrow(/model name RoomType collides with an incompatible definition/);
  });
});
