import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPagesRegistrySnapshot,
  type FluxPageRegistryTarget,
  type PagesRegistryOptions,
} from "../src/pages-registry";
import { generateFluxFastProject, checkFluxFastProject } from "../src/generate";

const fixture = path.resolve(__dirname, "../../../tests/fixtures/adapter-baseline-v1.1.0");
const baseline = JSON.parse(fs.readFileSync(path.join(fixture, "baseline.json"), "utf8"));
const nextTarget: FluxPageRegistryTarget = {
  runtimeImport: "@fluxfast/next",
  rootExport: "FluxRoot",
  applicationPropsExport: "FluxApplicationProps",
  clientDirective: true,
};
const roots: string[] = [];

function project(layout: "root" | "src" = "src"): PagesRegistryOptions {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-registry-target-"));
  roots.push(root);
  const prefix = layout === "src" ? "src" : "";
  const pagesDir = path.join(root, prefix, "flux-pages");
  const outputFile = path.join(root, prefix, ".fluxfast/pages.generated.ts");
  for (const [file, content] of Object.entries(baseline.pages)) {
    const target = path.join(pagesDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content as string);
  }
  return { pagesDir, outputFile, target: nextTarget };
}

function compileSource(source: string, module: "CommonJS" | "ESNext" = "CommonJS"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-registry-compile-"));
  roots.push(root);
  const input = path.join(root, "registry-source.ts");
  fs.writeFileSync(input, source);
  // Like transpileModule, this checks syntax and emits runnable JS without
  // needing a framework install. The packed consumer separately checks types.
  const compiled = spawnSync(process.execPath, [
    path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
    "--noCheck", "--noResolve", "--module", module, "--target", "ES2022",
    "--esModuleInterop", "--outDir", path.join(root, "compiled"), input,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  return fs.readFileSync(path.join(root, "compiled/registry-source.js"), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("adapter-aware page registry compilation", () => {
  it("resolves default source/output paths against the caller working directory", () => {
    const options = project();
    const root = path.dirname(path.dirname(options.pagesDir!));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const snapshot = createPagesRegistrySnapshot({ target:nextTarget });
    expect(snapshot.pagesDir).toBe(options.pagesDir);
    expect(snapshot.outputFile).toBe(options.outputFile);
    expect(snapshot.content).toBe(fs.readFileSync(path.join(fixture, "pages.generated.ts"), "utf8"));
    expect(fs.existsSync(path.dirname(snapshot.outputFile))).toBe(false);
  });

  it.each(["root", "src"] as const)("preserves every published Next registry byte in the %s layout without writing", layout => {
    const options = project(layout);
    const snapshot = createPagesRegistrySnapshot(options);
    expect(snapshot.content).toBe(fs.readFileSync(path.join(fixture, "pages.generated.ts"), "utf8"));
    expect(snapshot.files).toEqual(["(admin)/[room-id].tsx", "home/index.tsx", "hotel_rooms/index.tsx", "legacy.jsx"]);
    expect(snapshot.identifiers).toEqual(["(admin)/[room-id]", "home/index", "hotel_rooms/index", "legacy"]);
    expect(fs.existsSync(path.dirname(options.outputFile!))).toBe(false);
    expect(snapshot).toEqual(createPagesRegistrySnapshot(options));
  });

  it("uses configured runtime exports while retaining stable generated names", () => {
    const options = project();
    const content = createPagesRegistrySnapshot({ ...options, target: {
      runtimeImport: "@acme/host-runtime", rootExport: "ApplicationRoot",
      applicationPropsExport: "ApplicationInput", clientDirective: true,
    } }).content;
    expect(content).toContain('import { ApplicationRoot as FluxRoot } from "@acme/host-runtime";');
    expect(content).toContain('import type { ComponentRegistry, ApplicationInput as FluxApplicationProps } from "@acme/host-runtime";');
    expect(content).toContain("export function FluxApplication(props: FluxApplicationProps)");
    expect(content).toContain("React.createElement(FluxRoot, { ...props, registry: fluxPages })");
    expect(content).not.toContain("@fluxfast/next");
  });

  it.each([undefined, false, true])("adds the client directive only when explicitly true (%s)", clientDirective => {
    const content = createPagesRegistrySnapshot({ ...project(), target: { ...nextTarget, clientDirective } }).content;
    expect(content.includes('"use client";')).toBe(clientDirective === true);
    expect(content.startsWith("// AUTO-GENERATED BY FLUXFAST.\n// DO NOT EDIT MANUALLY.\n")).toBe(true);
  });

  it("scans an absent source without creating source or output directories", () => {
    const options = project();
    fs.rmSync(options.pagesDir!, { recursive: true });
    const snapshot = createPagesRegistrySnapshot(options);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.identifiers).toEqual([]);
    expect(fs.existsSync(options.pagesDir!)).toBe(false);
    expect(fs.existsSync(path.dirname(options.outputFile!))).toBe(false);
  });

  it("ignores nested source symlinks rather than importing their external files", () => {
    const options = project();
    const outside = path.join(roots.at(-1)!, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.tsx"), "export default null;");
    fs.symlinkSync(outside, path.join(options.pagesDir!, "external"), process.platform === "win32" ? "junction" : "dir");
    const snapshot = createPagesRegistrySnapshot(options);
    expect(snapshot.content).not.toContain("secret");
    expect(snapshot.content).not.toContain("external");
  });

  it("rejects duplicate page identifiers before writing any generated artifact", () => {
    const options = project();
    fs.writeFileSync(path.join(options.pagesDir!, "home/index.jsx"), "export default null;");
    expect(() => createPagesRegistrySnapshot(options)).toThrow(/Duplicate FluxFast page identifier/);
    expect(fs.existsSync(path.dirname(options.outputFile!))).toBe(false);
  });

  it.each(['page".tsx', "page space.tsx", "page'.jsx"])("rejects unsafe source filename %s", filename => {
    const options = project();
    fs.writeFileSync(path.join(options.pagesDir!, filename), "export default null;");
    expect(() => createPagesRegistrySnapshot(options)).toThrow(/Page path contains unsupported characters/);
    expect(fs.existsSync(path.dirname(options.outputFile!))).toBe(false);
  });

  it("feeds safe project generation and drift checks through the same snapshot contract", () => {
    const options = project();
    const registry = createPagesRegistrySnapshot({ ...options, target: {
      runtimeImport: "@acme/host-runtime", rootExport: "ApplicationRoot", applicationPropsExport: "ApplicationInput",
    } });
    const input = {registry, log:false, schemaContent:fs.readFileSync(path.join(fixture, "schema.generated.json"), "utf8")};
    const missing = checkFluxFastProject(input);
    expect(missing.current).toBe(false);
    expect(fs.existsSync(path.dirname(registry.outputFile))).toBe(false);
    generateFluxFastProject(input);
    expect(fs.readFileSync(registry.outputFile, "utf8")).toBe(registry.content);
    expect(checkFluxFastProject(input).current).toBe(true);
    for (const filename of ["schema.generated.json", "types.generated.ts", "validators.generated.ts", "routes.generated.ts", "mutations.generated.ts"]) {
      expect(fs.readFileSync(path.join(path.dirname(registry.outputFile), filename), "utf8")).toBe(fs.readFileSync(path.join(fixture, filename), "utf8"));
    }
  });
});

describe("registry target source safety", () => {
  it.each([undefined, null, {}, [], { ...nextTarget, clientDirective: "yes" }, { ...nextTarget, clientDirective: null }])("rejects a malformed target %#", target => {
    expect(() => createPagesRegistrySnapshot({ ...project(), target } as PagesRegistryOptions)).toThrow(/page registry target/i);
  });

  it.each(["", "   ", "\n@acme/runtime", "@acme\u0000/runtime"])("rejects an empty or control-character runtime specifier %#", runtimeImport => {
    expect(() => createPagesRegistrySnapshot({ ...project(), target:{...nextTarget, runtimeImport} })).toThrow(/runtimeImport/);
  });

  it.each(["", "Root;globalThis.compromised=true", "Root.WithMember", "Root\nOther", "{Root}", "Root as Other"])("rejects unsafe export identifiers %#", exportName => {
    for (const property of ["rootExport", "applicationPropsExport"] as const) {
      expect(() => createPagesRegistrySnapshot({ ...project(), target:{...nextTarget, [property]:exportName} })).toThrow(new RegExp(property));
    }
  });

  it("escapes an opaque quoted runtime specifier as module data, not executable source", () => {
    const runtimeImport = '@acme/runtime"; globalThis.compromised = true; //';
    const source = createPagesRegistrySnapshot({ ...project(), target: {
      runtimeImport, rootExport:"ApplicationRoot", applicationPropsExport:"ApplicationInput",
    } }).content;
    expect(source).toContain(`from ${JSON.stringify(runtimeImport)};`);
    // A non-installable module specifier can still be checked as literal ESM
    // data without resolving that module or relying on CJS emitter identifiers.
    const emitted = compileSource(source, "ESNext");
    expect(emitted).toContain(`from ${JSON.stringify(runtimeImport)};`);
    const parsed = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input:emitted, encoding:"utf8", timeout:30_000,
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it.each([
    ["@acme/host-runtime", "ApplicationRoot", "ApplicationInput"],
    ["@acme/host-runtime", "default", "default"],
    ["@acme/host-runtime", "React", "FluxApplication"],
    ["@acme/host-runtime", "FluxApplication", "ComponentRegistry"],
  ])("treats the runtime specifier as data and renders the selected root with its allowlisted registry (%s, %s, %s)", async (runtimeImport, rootExport, applicationPropsExport) => {
    const options = project();
    const source = createPagesRegistrySnapshot({ ...options, target:{
      runtimeImport, rootExport, applicationPropsExport, clientDirective:false,
    } }).content;
    const compiled = compileSource(source);
    const calls: string[] = [];
    const Root = () => null;
    const Page = () => null;
    const exports: Record<string, any> = {};
    const require = (name: string) => {
      calls.push(name);
      if (name === "react") return {createElement:(root: unknown, props: unknown) => ({root, props})};
      if (name === runtimeImport) return {__esModule:true, [rootExport]:Root};
      if (name === "../flux-pages/home/index") return {__esModule:true, default:Page};
      throw new Error(`unexpected module ${name}`);
    };
    const evaluator = new Function("require", "exports", compiled);
    evaluator(require, exports);
    const bootstrap = {initialEnvelope:{page:{component:"home/index"}}, registry:"cannot override generated allowlist"};
    const result = exports.FluxApplication(bootstrap);
    expect(result).toEqual({root:Root, props:{...bootstrap, registry:exports.fluxPages}});
    expect(exports.default).toBe(exports.fluxPages);
    expect((await exports.fluxPages["home/index"].load()).default).toBe(Page);
    expect(calls).toEqual(["react", runtimeImport, "../flux-pages/home/index"]);
    expect((globalThis as any).compromised).toBeUndefined();
  });
});
