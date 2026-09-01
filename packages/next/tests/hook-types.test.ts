import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileFluxFastResourceTypes } from "../src/schema-compiler";

describe("generated resource hook types", () => {
  it("infers registered keys while preserving dynamic and explicit types", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-hook-types-"));
    const generatedFile = path.join(directory, "types.generated.ts");
    const consumerFile = path.join(directory, "consumer.ts");
    const configFile = path.join(directory, "tsconfig.json");

    fs.writeFileSync(
      generatedFile,
      compileFluxFastResourceTypes({
        schema: "fluxfast-schema/1",
        producer: "0.6.0",
        fingerprint: "f".repeat(64),
        resources: {
          rooms: {
            schema: {
              type: "array",
              items: { $ref: "#/$defs/Room" },
              $defs: {
                Room: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    number: { type: "string" }
                  },
                  required: ["id", "number"]
                }
              }
            }
          },
          analytics: {
            schema: {
              type: "object",
              properties: { revenue: { type: "number" } },
              required: ["revenue"]
            }
          }
        },
        pages: [],
        mutations: []
      }),
      "utf8"
    );
    fs.writeFileSync(
      consumerFile,
      `import type { ResourceStateSnapshot } from "@fluxfast/core";
import {
  type DeferredResourceResult,
  useDeferredResource,
  useResource,
  useResourceState
} from "@fluxfast/next/client";
import "./types.generated";

interface ManualResource {
  label: string;
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

const rooms = useResource("rooms");
const roomsState = useResourceState("rooms");
const analytics = useDeferredResource("analytics");
const dynamic = useResource("dynamic-resource");
const dynamicState = useResourceState("dynamic-resource");
const dynamicDeferred = useDeferredResource("dynamic-resource");
const explicit = useResource<ManualResource>("dynamic-resource");
const explicitState = useResourceState<ManualResource>("dynamic-resource");
const explicitDeferred = useDeferredResource<ManualResource>("dynamic-resource");

type RoomsContract = Assert<Equal<typeof rooms, import("./types.generated").Room[]>>;
type StateContract = Assert<Equal<
  typeof roomsState,
  ResourceStateSnapshot<import("./types.generated").Room[]>
>>;
type DeferredContract = Assert<Equal<
  typeof analytics,
  DeferredResourceResult<import("./types.generated").AnalyticsResource>
>>;
type DynamicContract = Assert<Equal<typeof dynamic, unknown>>;
type DynamicStateContract = Assert<Equal<
  typeof dynamicState,
  ResourceStateSnapshot<unknown>
>>;
type DynamicDeferredContract = Assert<Equal<
  typeof dynamicDeferred,
  DeferredResourceResult<unknown>
>>;
type ExplicitContract = Assert<Equal<typeof explicit, ManualResource>>;
type ExplicitStateContract = Assert<Equal<
  typeof explicitState,
  ResourceStateSnapshot<ManualResource>
>>;
type ExplicitDeferredContract = Assert<Equal<
  typeof explicitDeferred,
  DeferredResourceResult<ManualResource>
>>;

rooms[0].number.toUpperCase();
roomsState.data?.[0].number.toUpperCase();
analytics.data?.revenue.toFixed(2);
explicit.label.toUpperCase();
explicitState.data?.label.toUpperCase();
explicitDeferred.data?.label.toUpperCase();

// @ts-expect-error inferred room identifiers are numeric
rooms[0].id = "wrong";
// @ts-expect-error inferred room records reject fields absent from the contract
rooms[0].nonexistent;
// @ts-expect-error resource state data retains the generated room contract
roomsState.data?.[0].nonexistent;
// @ts-expect-error deferred data retains the generated analytics contract
analytics.data?.nonexistent;
// @ts-expect-error unknown dynamic resources must be narrowed or explicitly typed
dynamic.label;

void (null as unknown as [
  RoomsContract,
  StateContract,
  DeferredContract,
  DynamicContract,
  DynamicStateContract,
  DynamicDeferredContract,
  ExplicitContract,
  ExplicitStateContract,
  ExplicitDeferredContract
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
          jsx: "react-jsx",
          types: ["node"],
          typeRoots: [
            path.resolve(__dirname, "../node_modules/@types")
          ],
          strict: true,
          skipLibCheck: true,
          paths: {
            "@fluxfast/core": [
              path.resolve(__dirname, "../../core/src/index.ts")
            ],
            "@fluxfast/next/client": [
              path.resolve(__dirname, "../src/client.ts")
            ]
          }
        },
        files: [generatedFile, consumerFile]
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
