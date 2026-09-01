import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("FluxResourceMap type registry", () => {
  it("supports package-root augmentation and unknown dynamic resource keys", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-core-types-"));
    const sourceFile = path.join(directory, "resource-map.ts");
    const configFile = path.join(directory, "tsconfig.json");
    const coreEntry = path.resolve(__dirname, "../src/index.ts");

    fs.writeFileSync(
      sourceFile,
      `import type {
  FluxResourceKey,
  FluxResourceMap,
  FluxResourceValue
} from "@fluxfast/core";

interface Room {
  id: number;
}

declare module "@fluxfast/core" {
  interface FluxResourceMap {
    rooms: Room[];
    "room-types": string[];
  }
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type MapContract = Assert<Equal<FluxResourceMap["rooms"], Room[]>>;
type KeyContract = Assert<Equal<FluxResourceKey, "rooms" | "room-types">>;
type RoomsContract = Assert<Equal<FluxResourceValue<"rooms">, Room[]>>;
type DynamicContract = Assert<Equal<FluxResourceValue<"dynamic">, unknown>>;

const roomsKey: FluxResourceKey = "rooms";
const roomTypesKey: FluxResourceKey = "room-types";
const rooms: FluxResourceValue<"rooms"> = [{ id: 1 }];

// @ts-expect-error unknown keys are not registered keys
const invalidKey: FluxResourceKey = "dynamic";
// @ts-expect-error registered values retain their generated contract
const invalidRooms: FluxResourceValue<"rooms"> = [{ id: "wrong" }];

void [
  roomsKey,
  roomTypesKey,
  rooms,
  invalidKey,
  invalidRooms
];
void (null as unknown as [
  MapContract,
  KeyContract,
  RoomsContract,
  DynamicContract
]);
`,
      "utf8"
    );
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
          paths: { "@fluxfast/core": [coreEntry] }
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
  });
});
