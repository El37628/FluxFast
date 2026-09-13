import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const SOURCE_ARTIFACT_NAMES = [
  "mutations.generated.ts",
  "pages.generated.ts",
  "routes.generated.ts",
  "types.generated.ts",
  "validators.generated.ts"
] as const;

interface GeneratedSemanticExports {
  componentRegistryIdentifiers: string[];
  domainInterfaces: string[];
  mutationHelpers: string[];
  pageExports: string[];
  resourceAliases: Record<string, string>;
  resourceKeys: Record<string, string>;
  resourceMap: Record<string, string>;
  resourceMapAugmentation: Record<string, string>;
  routeBuilders: string[];
  validatorExports: string[];
  validators: string[];
}

interface GeneratedContractSnapshot {
  generatedArtifacts: string[];
  semanticExports: GeneratedSemanticExports;
  sourceFingerprints: Record<string, string>;
}

interface GeneratedContractBaseline extends GeneratedContractSnapshot {
  candidatePackage: string;
  capturedFrom: string;
}

const schemaFixture = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../../tests/fixtures/schema/fluxfast-schema-v2.json"
  ),
  "utf8"
);

function prepareProject(root: string, schemaContent = schemaFixture): {
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
    schemaContent,
    log: false
  });
  return { generatedDir, result };
}

function sourceTokens(source: string): string[] {
  const tokenPattern =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][A-Za-z0-9_$]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|./gy;
  const tokens: string[] = [];
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^\s/.test(token) || token.startsWith("//") || token.startsWith("/*")) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function sourceFingerprint(source: string): string {
  return createHash("sha256")
    .update(sourceTokens(source).join("\n"))
    .digest("hex");
}

function generatedSource(generatedDir: string, name: string): string {
  return fs.readFileSync(path.join(generatedDir, name), "utf8");
}

function decodePropertyToken(token: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) return token;
  if (token.startsWith('"')) return JSON.parse(token) as string;
  throw new TypeError(`Unsupported generated property token ${token}`);
}

function findSequence(tokens: string[], sequence: string[]): number {
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) {
      return index;
    }
  }
  return -1;
}

function exportedObjectEntries(
  source: string,
  exportName: string
): Array<{ key: string; valueToken: string }> {
  const tokens = sourceTokens(source);
  const declaration = findSequence(tokens, ["export", "const", exportName]);
  if (declaration < 0) {
    throw new TypeError(`Missing generated object export ${exportName}`);
  }
  const openingBrace = tokens.indexOf("{", declaration + 3);
  if (openingBrace < 0) {
    throw new TypeError(`Missing generated object body ${exportName}`);
  }

  const entries: Array<{ key: string; valueToken: string }> = [];
  let braceDepth = 1;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let expectingProperty = true;
  for (let index = openingBrace + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "{") {
      braceDepth += 1;
      continue;
    }
    if (token === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return entries;
      continue;
    }
    if (token === "[") {
      bracketDepth += 1;
      continue;
    }
    if (token === "]") {
      bracketDepth -= 1;
      continue;
    }
    if (token === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (token === ")") {
      parenthesisDepth -= 1;
      continue;
    }
    if (braceDepth !== 1 || bracketDepth !== 0 || parenthesisDepth !== 0) {
      continue;
    }
    if (token === ",") {
      expectingProperty = true;
      continue;
    }
    if (expectingProperty && tokens[index + 1] === ":") {
      entries.push({
        key: decodePropertyToken(token),
        valueToken: tokens[index + 2]
      });
      expectingProperty = false;
    }
  }
  throw new TypeError(`Unterminated generated object export ${exportName}`);
}

function objectKeys(source: string, exportName: string): string[] {
  return exportedObjectEntries(source, exportName)
    .map(entry => entry.key)
    .sort();
}

function stringObject(
  source: string,
  exportName: string
): Record<string, string> {
  const entries = exportedObjectEntries(source, exportName).map(entry => {
    if (!entry.valueToken.startsWith('"')) {
      throw new TypeError(`Generated ${exportName} value must be a string`);
    }
    return [entry.key, JSON.parse(entry.valueToken) as string] as const;
  });
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right))
  );
}

function generatedInterfaceMap(
  source: string,
  interfaceName: string
): Record<string, string> {
  const tokens = sourceTokens(source);
  const declaration = findSequence(tokens, ["interface", interfaceName]);
  if (declaration < 0) {
    throw new TypeError(`Missing generated interface ${interfaceName}`);
  }
  const openingBrace = tokens.indexOf("{", declaration + 2);
  if (openingBrace < 0) {
    throw new TypeError(`Missing generated interface body ${interfaceName}`);
  }
  const entries: Array<readonly [string, string]> = [];
  let expectingProperty = true;
  for (let index = openingBrace + 1; index < tokens.length; index += 1) {
    if (tokens[index] === "}") break;
    if (tokens[index] === ";") {
      expectingProperty = true;
      continue;
    }
    if (!expectingProperty || tokens[index + 1] !== ":") continue;
    const end = tokens.indexOf(";", index + 2);
    if (end < 0) throw new TypeError(`Unterminated ${interfaceName} member`);
    entries.push([
      decodePropertyToken(tokens[index]),
      tokens.slice(index + 2, end).join("")
    ] as const);
    index = end - 1;
    expectingProperty = false;
  }
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right))
  );
}

function pageExportNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /^export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
  )) {
    names.push(match[1]);
  }
  for (const match of source.matchAll(
    /^export\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
  )) {
    names.push(match[1]);
  }
  if (/^export\s+default\b/m.test(source)) names.push("default");
  return names.sort();
}

function createGeneratedContractSnapshot(
  generatedDir: string
): GeneratedContractSnapshot {
  const types = generatedSource(generatedDir, "types.generated.ts");
  const validators = generatedSource(generatedDir, "validators.generated.ts");
  const routes = generatedSource(generatedDir, "routes.generated.ts");
  const mutations = generatedSource(generatedDir, "mutations.generated.ts");
  const pages = generatedSource(generatedDir, "pages.generated.ts");

  const domainInterfaces = [
    ...types.matchAll(
      /^export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
    )
  ]
    .map(match => match[1])
    .filter(name => name !== "GeneratedFluxResourceMap")
    .sort();
  const resourceAliases = Object.fromEntries(
    [
      ...types.matchAll(
        /^export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*Resource)\s*=\s*([^;]+);/gm
      )
    ]
      .map(match => [match[1], match[2].replace(/\s+/g, " ").trim()] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const validatorExports = [
    ...validators.matchAll(
      /^export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm
    )
  ]
    .map(match => match[1])
    .sort();

  return {
    generatedArtifacts: fs.readdirSync(generatedDir).sort(),
    sourceFingerprints: Object.fromEntries(
      SOURCE_ARTIFACT_NAMES.map(name => [
        name,
        sourceFingerprint(fs.readFileSync(path.join(generatedDir, name), "utf8"))
      ])
    ),
    semanticExports: {
      componentRegistryIdentifiers: objectKeys(pages, "fluxPages"),
      domainInterfaces,
      mutationHelpers: objectKeys(mutations, "mutations"),
      pageExports: pageExportNames(pages),
      resourceAliases,
      resourceKeys: stringObject(types, "resourceKeys"),
      resourceMap: generatedInterfaceMap(types, "GeneratedFluxResourceMap"),
      resourceMapAugmentation: generatedInterfaceMap(types, "FluxResourceMap"),
      routeBuilders: objectKeys(routes, "routes"),
      validatorExports,
      validators: objectKeys(validators, "validators")
    }
  };
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

  it("matches the v0.9 generated contract for the v1 candidate", () => {
    const baseline = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../tests/fixtures/generated-contract-v0.9.0.json"
        ),
        "utf8"
      )
    ) as GeneratedContractBaseline;
    expect(baseline.capturedFrom).toBe("@fluxfast/next@0.9.0");
    expect(baseline.candidatePackage).toBe("1.0.0");

    const reference = createGeneratedContractSnapshot(
      prepareProject(temporaryProject()).generatedDir
    );
    expect(reference).toEqual({
      generatedArtifacts: baseline.generatedArtifacts,
      semanticExports: baseline.semanticExports,
      sourceFingerprints: baseline.sourceFingerprints
    });

    const candidateManifest = JSON.parse(schemaFixture) as Record<
      string,
      unknown
    >;
    candidateManifest.producer = baseline.candidatePackage;
    const candidate = createGeneratedContractSnapshot(
      prepareProject(
        temporaryProject(),
        `${JSON.stringify(candidateManifest, null, 2)}\n`
      ).generatedDir
    );

    expect(candidate).toEqual(reference);
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
