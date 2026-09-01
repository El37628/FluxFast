import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileFluxFastMutations } from "../src/mutation-compiler";

const fingerprint = "d".repeat(64);

function manifest(mutations: unknown[]) {
  return {
    schema: "fluxfast-schema/1",
    producer: "0.6.0",
    fingerprint,
    resources: {},
    pages: [],
    mutations
  };
}

function compileAndRun(
  source: string,
  consumer: string,
  evaluation: string
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-mutations-"));
  const sourceFile = path.join(directory, "mutations.generated.ts");
  const consumerFile = path.join(directory, "consumer.ts");
  const configFile = path.join(directory, "tsconfig.json");
  const outputDirectory = path.join(directory, "dist");
  fs.writeFileSync(sourceFile, source, "utf8");
  fs.writeFileSync(consumerFile, consumer, "utf8");
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
        noEmit: true,
        paths: {
          "@fluxfast/core": [
            path.resolve(__dirname, "../../core/src/index.ts")
          ]
        }
      },
      files: [sourceFile, consumerFile]
    }, null, 2)}\n`,
    "utf8"
  );

  try {
    const compilation = spawnSync(
      path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
      ["--project", configFile],
      { encoding: "utf8" }
    );
    expect(`${compilation.stdout}${compilation.stderr}`).toBe("");
    expect(compilation.status).toBe(0);

    const emission = spawnSync(
      path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
      [
        "--ignoreConfig",
        "--noCheck",
        "--target",
        "ES2022",
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        "--outDir",
        outputDirectory,
        sourceFile
      ],
      { encoding: "utf8" }
    );
    expect(`${emission.stdout}${emission.stderr}`).toBe("");
    expect(emission.status).toBe(0);

    const generatedJavaScript = path.join(
      outputDirectory,
      "mutations.generated.js"
    );
    const execution = spawnSync(
      process.execPath,
      [
        "-e",
        `const { mutations } = require(${JSON.stringify(generatedJavaScript)}); ${evaluation}`
      ],
      { encoding: "utf8" }
    );
    expect(execution.stderr).toBe("");
    expect(execution.status).toBe(0);
    return execution.stdout;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function updateRoom(method = "PATCH") {
  return {
    name: "update_room",
    path: "/rooms/{room_id}",
    method,
    parameters: [
      {
        name: "notify",
        location: "query",
        required: false,
        schema: { default: true, type: "boolean" }
      },
      {
        name: "room_id",
        location: "path",
        required: true,
        schema: { type: "integer" }
      }
    ],
    body: {
      $defs: {
        UpdateRoom: {
          type: "object",
          properties: {
            note: { type: "string" },
            status: { enum: ["available", "occupied"], type: "string" }
          },
          required: ["status"]
        }
      },
      $ref: "#/$defs/UpdateRoom"
    }
  };
}

describe("FluxFast mutation compiler", () => {
  it("generates typed FluxRouter helpers with encoded paths and queries", () => {
    const output = compileFluxFastMutations(manifest([updateRoom()]));
    expect(output).toContain("updateRoom: (");
    expect(output).toContain("router: FluxRouter");
    expect(output).toContain("room_id: number;");
    expect(output).toContain("notify?: boolean;");
    expect(output).toContain('status: "available" | "occupied";');
    expect(output).toContain('{ method: "PATCH" }');

    const consumer = `import type { FluxRouter } from "@fluxfast/core";
import { mutations } from "./mutations.generated";

declare const router: FluxRouter;
mutations.updateRoom(router, {
  params: { room_id: 101 },
  query: { notify: true },
  body: { status: "available", note: "ready" }
});

// @ts-expect-error integer path parameters require numbers
mutations.updateRoom(router, { params: { room_id: "101" }, body: { status: "available" } });
// @ts-expect-error mutation bodies retain their enum contract
mutations.updateRoom(router, { params: { room_id: 101 }, body: { status: "closed" } });
`;
    const stdout = compileAndRun(
      output,
      consumer,
      `const calls = [];
const router = {
  mutate(url, data, options) {
    calls.push([url, data, options]);
    return Promise.resolve({ protocol: "fluxfast/1", mutation: {} });
  }
};
mutations.updateRoom(router, {
  params: { room_id: 101 },
  query: { notify: true },
  body: { status: "occupied", note: "a&b" }
}).then(() => process.stdout.write(JSON.stringify(calls)));`
    );
    expect(JSON.parse(stdout)).toEqual([
      [
        "/rooms/101?notify=true",
        { status: "occupied", note: "a&b" },
        { method: "PATCH" }
      ]
    ]);
  });

  it("suffixes multi-method operations and omits non-JSON mutations", () => {
    const output = compileFluxFastMutations(
      manifest([
        { ...updateRoom("PUT"), name: "save_room" },
        { ...updateRoom("PATCH"), name: "save_room" },
        {
          name: "upload_room_photo",
          path: "/rooms/{room_id}/photo",
          method: "POST",
          parameters: [
            {
              name: "room_id",
              location: "path",
              required: true,
              schema: { type: "integer" }
            }
          ],
          body: null
        }
      ])
    );
    expect(output).toContain("saveRoomPatch: (");
    expect(output).toContain("saveRoomPut: (");
    expect(output).not.toContain("uploadRoomPhoto");
    expect(output.indexOf("saveRoomPatch:")).toBeLessThan(
      output.indexOf("saveRoomPut:")
    );
  });

  it("rejects operation-name and placeholder collisions", () => {
    expect(() =>
      compileFluxFastMutations(
        manifest([
          updateRoom(),
          {
            ...updateRoom("POST"),
            name: "update-room",
            path: "/other/{room_id}"
          }
        ])
      )
    ).toThrow(/Give the FluxFast mutation route an explicit unique name/);

    expect(() =>
      compileFluxFastMutations(
        manifest([
          {
            ...updateRoom(),
            path: "/rooms/{missing}"
          }
        ])
      )
    ).toThrow(/placeholder "missing" must have exactly one path parameter/);
  });

  it("generates a valid empty module when no typed JSON bodies exist", () => {
    const output = compileFluxFastMutations(
      manifest([
        {
          name: "logout",
          path: "/logout",
          method: "POST",
          parameters: [],
          body: null
        }
      ])
    );
    expect(output).toContain("export const mutations = {} as const;");
    expect(output).not.toContain("FluxRouter");
  });
});
