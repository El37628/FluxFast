import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VALIDATION_FORMATS } from "@fluxfast/core";
import {
  checkFluxFastProject,
  compileJsonSchemaToValidationPlan,
  findFluxFastSchemaModeConflicts,
  generateFluxFastProject,
  generatePagesRegistry,
  parseFluxFastSchemaManifest,
  type FluxFastGenerationOptions,
} from "../src/index";

const roots: string[] = [];
const schemaContent = fs.readFileSync(
  path.resolve(__dirname, "../../../tests/fixtures/schema/fluxfast-schema-v2.json"),
  "utf8"
);

function project(): FluxFastGenerationOptions {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-codegen-"));
  roots.push(root);
  const generatedDir = path.join(root, "src/.fluxfast");
  return {
    generatedDir,
    log: false,
    schemaContent,
    registry: {
      content: "// Supplied by an adapter, with no framework dependency.\nexport const pages = {};\n",
      files: [],
      identifiers: [],
      outputFile: path.join(generatedDir, "pages.generated.ts"),
      pagesDir: path.join(root, "src/pages"),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("framework-neutral project generation", () => {
  it("persists all six artifacts and preserves the adapter-supplied registry bytes", () => {
    const options = project();
    const result = generateFluxFastProject(options);
    expect(fs.readdirSync(options.generatedDir!).sort()).toEqual([
      "mutations.generated.ts", "pages.generated.ts", "routes.generated.ts",
      "schema.generated.json", "types.generated.ts", "validators.generated.ts",
    ]);
    expect(result.generatedFiles).toHaveLength(5);
    expect(fs.readFileSync(result.registryPath, "utf8")).toBe(options.registry.content);
    expect(fs.readFileSync(result.schemaFile!, "utf8")).toBe(schemaContent);
    expect(checkFluxFastProject(options).current).toBe(true);
  });

  it("checks missing and stale artifacts without creating or modifying anything", () => {
    const options = project();
    const missing = checkFluxFastProject(options);
    expect(missing.checkedFiles).toHaveLength(6);
    expect(missing.staleFiles).toEqual(missing.checkedFiles);
    expect(fs.existsSync(options.generatedDir!)).toBe(false);
    generateFluxFastProject(options);
    fs.writeFileSync(options.registry.outputFile, "old registry");
    expect(checkFluxFastProject(options).staleFiles).toEqual([options.registry.outputFile]);
    expect(fs.readFileSync(options.registry.outputFile, "utf8")).toBe("old registry");
  });

  it("validates every schema-backed artifact before replacing existing files", () => {
    const options = project();
    generateFluxFastProject(options);
    const before = fs.readdirSync(options.generatedDir!).map(name => [
      name, fs.readFileSync(path.join(options.generatedDir!, name), "utf8"),
    ]);
    expect(() => generateFluxFastProject({ ...options, schemaContent: "{\"schema\":\"unsupported\"}" })).toThrow();
    expect(fs.readdirSync(options.generatedDir!).map(name => [
      name, fs.readFileSync(path.join(options.generatedDir!, name), "utf8"),
    ])).toEqual(before);
  });

  it.each(["../outside.json", "nested/../../outside.json"])("rejects escaping schema output %s", file => {
    const options = project();
    expect(() => generateFluxFastProject({
      ...options, schemaFile: path.resolve(options.generatedDir!, file),
    })).toThrow(/stay inside/);
    expect(fs.existsSync(options.generatedDir!)).toBe(false);
  });

  it("rejects a registry outside the configured output directory", () => {
    const options = project();
    options.registry.outputFile = path.join(path.dirname(options.generatedDir!), "outside.ts");
    expect(() => generateFluxFastProject(options)).toThrow(/stay inside/);
  });

  it.each(["directory", "target"])("rejects symbolic-link %s traversal", kind => {
    const options = project();
    const outside = path.join(roots.at(-1)!, "outside");
    fs.mkdirSync(outside);
    if (kind === "directory") {
      fs.mkdirSync(path.dirname(options.generatedDir!), { recursive: true });
      fs.symlinkSync(outside, options.generatedDir!, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.mkdirSync(options.generatedDir!, { recursive: true });
      const outsideFile = path.join(outside, "registry.ts");
      fs.writeFileSync(outsideFile, "unchanged");
      fs.symlinkSync(outsideFile, options.registry.outputFile, "file");
    }
    expect(() => generateFluxFastProject(options)).toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual(kind === "directory" ? [] : ["registry.ts"]);
  });

  it("leaves the old registry intact and cleans only its own temporary file after failed rename", () => {
    const options = project();
    generatePagesRegistry(options.registry, { log: false });
    const error = new Error("simulated rename failure");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw error; });
    expect(() => generatePagesRegistry({ ...options.registry, content: "replacement" }, { log: false })).toThrow(error);
    expect(fs.readFileSync(options.registry.outputFile, "utf8")).toBe(options.registry.content);
    expect(fs.readdirSync(options.generatedDir!)).toEqual(["pages.generated.ts"]);
  });

  it("does not delete a pre-existing temporary path when exclusive creation fails", () => {
    const options = project();
    fs.mkdirSync(options.generatedDir!, { recursive: true });
    const open = fs.openSync.bind(fs);
    let collision = "";
    vi.spyOn(fs, "openSync").mockImplementationOnce((file, flags, mode) => {
      collision = String(file);
      fs.writeFileSync(collision, "not owned by this writer");
      return open(file, flags, mode);
    });
    expect(() => generatePagesRegistry(options.registry, { log: false })).toThrow();
    expect(fs.readFileSync(collision, "utf8")).toBe("not owned by this writer");
    expect(fs.existsSync(options.registry.outputFile)).toBe(false);
  });
});

describe("compiler contract boundaries", () => {
  it.each(VALIDATION_FORMATS)("supports Core's %s format without a runtime Core import", format => {
    expect(compileJsonSchemaToValidationPlan({ type: "string", format })).toEqual({
      root: { kind: "string", format },
    });
  });

  it("reports mode/name conflicts using the same deterministic compiler naming", () => {
    const manifest = parseFluxFastSchemaManifest(schemaContent);
    const conflicted = {
      ...manifest,
      types: {
        "user-input": { mode: "validation", schema: { type: "string" } },
        user_input: { mode: "serialization", schema: { type: "string" } },
      },
    };
    expect(findFluxFastSchemaModeConflicts(conflicted)).toEqual([
      '"user-input" (validation) and "user_input" (serialization) both generate UserInput',
    ]);
    expect(findFluxFastSchemaModeConflicts({ ...manifest, types: {} })).toEqual([]);
  });
});
