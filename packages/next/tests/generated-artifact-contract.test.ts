import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateFluxFastProject,
  generatePagesRegistry
} from "../src/generate";

const ARTIFACT_NAMES = [
  "mutations.generated.ts",
  "pages.generated.ts",
  "routes.generated.ts",
  "schema.generated.json",
  "types.generated.ts",
  "validators.generated.ts"
] as const;

const schemaFixture = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../../tests/fixtures/schema/fluxfast-schema-v2.json"
  ),
  "utf8"
);

function prepareProject(root: string): {
  generatedDir: string;
  result: ReturnType<typeof generateFluxFastProject>;
} {
  const pagesDir = path.join(root, "src/flux-pages");
  const generatedDir = path.join(root, "src/.fluxfast");
  fs.mkdirSync(path.join(pagesDir, "hotel_rooms"), { recursive: true });
  fs.writeFileSync(
    path.join(pagesDir, "hotel_rooms/index.tsx"),
    "export default function HotelRooms() { return null; }\n",
    "utf8"
  );
  const result = generateFluxFastProject({
    pagesDir,
    generatedDir,
    outputFile: path.join(generatedDir, "pages.generated.ts"),
    schemaFile: path.join(generatedDir, "schema.generated.json"),
    schemaContent: schemaFixture,
    log: false
  });
  return { generatedDir, result };
}

function readArtifacts(generatedDir: string): Map<string, Buffer> {
  return new Map(
    ARTIFACT_NAMES.map(name => [
      name,
      fs.readFileSync(path.join(generatedDir, name))
    ])
  );
}

function expectGeneratedContractToTypeCheck(generatedDir: string): void {
  const declarationsFile = path.join(generatedDir, "dependencies.d.ts");
  const consumerFile = path.join(generatedDir, "contract-consumer.ts");
  const configFile = path.join(generatedDir, "tsconfig.contract.json");
  fs.writeFileSync(
    declarationsFile,
    `declare module "@fluxfast/core" {
  export interface FluxResourceMap {}
  export interface MutationEnvelope {}
  export interface FluxRouter {
    mutate(
      url: string,
      data: unknown,
      options?: { method?: string }
    ): Promise<MutationEnvelope>;
  }
  export interface FluxValidator<T> {
    readonly validate: (value: unknown) => unknown;
    readonly validatedType?: T;
  }
  export function createValidator<T>(plan: unknown): FluxValidator<T>;
}

declare module "@fluxfast/next" {
  export type ComponentRegistry = Record<
    string,
    { load: () => Promise<unknown> }
  >;
  export interface FluxApplicationProps {
    readonly initialPath?: string;
  }
  export const FluxRoot: unknown;
}

declare module "react" {
  const React: {
    createElement(type: unknown, props: unknown): unknown;
  };
  export default React;
}
`,
    "utf8"
  );
  fs.writeFileSync(
    consumerFile,
    `import type {
  FluxResourceMap,
  FluxRouter,
  FluxValidator
} from "@fluxfast/core";
import type {
  CreateRoomInput,
  GeneratedFluxResourceMap,
  Room,
  RoomsResource,
  UpdateRoomBody,
  User
} from "./types.generated";
import { resourceKeys } from "./types.generated";
import {
  CreateRoomInputValidator,
  UpdateRoomBodyValidator,
  UserValidator,
  validatorDiagnostics,
  validators
} from "./validators.generated";
import { routes } from "./routes.generated";
import { mutations } from "./mutations.generated";
import defaultRegistry, {
  FluxApplication,
  fluxPages
} from "./pages.generated";

declare const resourceMap: FluxResourceMap;
declare const generatedMap: GeneratedFluxResourceMap;
declare const room: Room;
declare const rooms: RoomsResource;
declare const user: User;
declare const input: CreateRoomInput;
declare const body: UpdateRoomBody;
declare const router: FluxRouter;

const stableResourceKey: "rooms" = resourceKeys.rooms;
const augmentedRooms: RoomsResource = resourceMap.rooms;
const generatedRooms: RoomsResource = generatedMap.rooms;
CreateRoomInputValidator satisfies FluxValidator<CreateRoomInput>;
UpdateRoomBodyValidator satisfies FluxValidator<UpdateRoomBody>;
UserValidator satisfies FluxValidator<User>;
validators.CreateRoomInput satisfies FluxValidator<CreateRoomInput>;
validators.UpdateRoomBody satisfies FluxValidator<UpdateRoomBody>;
routes.hotelRooms({ hotel_id: 1, query: { minimumRate: "10" } });
mutations.updateRoom(router, {
  params: { room_id: 1 },
  query: { budget: 10 },
  body
});
fluxPages["hotel_rooms/index"];
defaultRegistry["hotel_rooms/index"];
FluxApplication({ initialPath: "/rooms" });
void [
  stableResourceKey,
  augmentedRooms,
  generatedRooms,
  room,
  rooms,
  user,
  input,
  validatorDiagnostics
];
`,
    "utf8"
  );
  fs.writeFileSync(
    configFile,
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: [],
        strict: true,
        skipLibCheck: true,
        noEmit: true
      },
      files: [
        declarationsFile,
        path.join(generatedDir, "types.generated.ts"),
        path.join(generatedDir, "validators.generated.ts"),
        path.join(generatedDir, "routes.generated.ts"),
        path.join(generatedDir, "mutations.generated.ts"),
        path.join(generatedDir, "pages.generated.ts"),
        consumerFile
      ]
    }, null, 2)}\n`,
    "utf8"
  );

  const compilation = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, "../node_modules/typescript/lib/tsc.js"),
      "--project",
      configFile
    ],
    { encoding: "utf8" }
  );
  expect(compilation.error).toBeUndefined();
  expect(`${compilation.stdout ?? ""}${compilation.stderr ?? ""}`).toBe("");
  expect(compilation.status).toBe(0);
}

describe("generated artifact compatibility contract", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function temporaryProject(): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fluxfast-generated-contract-")
    );
    temporaryDirectories.push(directory);
    return directory;
  }

  it("freezes generated filenames", () => {
    const { generatedDir, result } = prepareProject(temporaryProject());
    expect(fs.readdirSync(generatedDir).sort()).toEqual(ARTIFACT_NAMES);
    expect(result.generatedFiles.map(file => path.basename(file)).sort()).toEqual(
      ARTIFACT_NAMES.filter(name => name !== "schema.generated.json")
    );
    expect(path.basename(result.schemaFile!)).toBe("schema.generated.json");
  });

  it("keeps public exports and common generated names predictable", () => {
    const { generatedDir } = prepareProject(temporaryProject());
    // The compiler, rather than source formatting, proves the exported symbol,
    // registry-key, module-augmentation, and call-signature contract.
    expectGeneratedContractToTypeCheck(generatedDir);
  });

  it("is byte-for-byte deterministic for the same version and input", () => {
    const left = readArtifacts(prepareProject(temporaryProject()).generatedDir);
    const right = readArtifacts(prepareProject(temporaryProject()).generatedDir);

    expect([...left.keys()]).toEqual([...right.keys()]);
    for (const name of ARTIFACT_NAMES) {
      expect(left.get(name)!.equals(right.get(name)!)).toBe(true);
    }
  });

  it("compiles every artifact before making the first write", () => {
    const root = temporaryProject();
    const pagesDir = path.join(root, "src/flux-pages");
    const generatedDir = path.join(root, "src/.fluxfast");
    fs.mkdirSync(generatedDir, { recursive: true });
    for (const name of ARTIFACT_NAMES) {
      fs.writeFileSync(path.join(generatedDir, name), `original:${name}`, "utf8");
    }
    const invalidManifest = JSON.parse(schemaFixture) as {
      pages: unknown[];
    };
    invalidManifest.pages = [
      { name: "hotel-rooms", path: "/rooms", parameters: [] },
      { name: "hotel_rooms", path: "/other-rooms", parameters: [] }
    ];

    expect(() =>
      generateFluxFastProject({
        pagesDir,
        generatedDir,
        outputFile: path.join(generatedDir, "pages.generated.ts"),
        schemaFile: path.join(generatedDir, "schema.generated.json"),
        schemaContent: `${JSON.stringify(invalidManifest)}\n`,
        log: false
      })
    ).toThrow(/collides .* as TypeScript identifier routes\.hotelRooms/);

    for (const name of ARTIFACT_NAMES) {
      expect(fs.readFileSync(path.join(generatedDir, name), "utf8")).toBe(
        `original:${name}`
      );
    }
  });

  it("flushes a same-directory temporary file before replacing one artifact", () => {
    const root = temporaryProject();
    const pagesDir = path.join(root, "src/flux-pages");
    const outputFile = path.join(root, "src/.fluxfast/pages.generated.ts");
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, "previous complete artifact", "utf8");

    const open = vi.spyOn(fs, "openSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const flush = vi.spyOn(fs, "fsyncSync");
    const close = vi.spyOn(fs, "closeSync");
    const rename = vi.spyOn(fs, "renameSync");

    generatePagesRegistry({ pagesDir, outputFile, log: false });

    const temporaryPath = String(open.mock.calls[0][0]);
    const descriptor = open.mock.results[0].value;
    expect(path.dirname(temporaryPath)).toBe(path.dirname(outputFile));
    expect(path.basename(temporaryPath)).toMatch(
      /^\.pages\.generated\.ts\.\d+\..+\.tmp$/
    );
    expect(open.mock.calls[0][1]).toBe("wx");
    expect(write.mock.calls[0][0]).toBe(descriptor);
    expect(flush.mock.calls[0][0]).toBe(descriptor);
    expect(close.mock.calls[0][0]).toBe(descriptor);
    expect(rename.mock.calls[0]).toEqual([temporaryPath, outputFile]);
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0]
    );
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(
      flush.mock.invocationCallOrder[0]
    );
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]
    );
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      rename.mock.invocationCallOrder[0]
    );
    expect(fs.existsSync(temporaryPath)).toBe(false);
    expect(fs.readFileSync(outputFile, "utf8")).toContain(
      "AUTO-GENERATED BY FLUXFAST"
    );
  });

  it("keeps the previous file and cleans up when replacement fails", () => {
    const root = temporaryProject();
    const pagesDir = path.join(root, "src/flux-pages");
    const outputFile = path.join(root, "src/.fluxfast/pages.generated.ts");
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, "previous complete artifact", "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated rename failure"), {
        code: "EACCES"
      });
    });

    expect(() =>
      generatePagesRegistry({ pagesDir, outputFile, log: false })
    ).toThrow("simulated rename failure");
    expect(fs.readFileSync(outputFile, "utf8")).toBe(
      "previous complete artifact"
    );
    expect(fs.readdirSync(path.dirname(outputFile))).toEqual([
      "pages.generated.ts"
    ]);
  });
});
