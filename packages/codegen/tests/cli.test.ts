import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodegenCli, type CodegenCliIo } from "../src/cli/index";

const fixture = path.resolve(__dirname, "../../../tests/fixtures/adapter-baseline-v1.1.0");
const baseline = JSON.parse(fs.readFileSync(path.join(fixture, "baseline.json"), "utf8"));
const schema = fs.readFileSync(path.join(fixture, "schema.generated.json"), "utf8");

describe("framework-neutral Codegen CLI", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];
  let io: CodegenCliIo;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-codegen-cli-"));
    stdout = [];
    stderr = [];
    io = { cwd: root, stdout: message => stdout.push(message), stderr: message => stderr.push(message) };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function source(layout: "root" | "src" = "src"): string {
    fs.writeFileSync(path.join(root, "package.json"), '{"private":true}');
    const directory = layout === "src" ? path.join(root, "src") : root;
    fs.mkdirSync(path.join(directory, "app"), { recursive: true });
    for (const [file, content] of Object.entries(baseline.pages)) {
      const destination = path.join(directory, "flux-pages", file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content as string);
    }
    fs.writeFileSync(path.join(root, "backend-schema.json"), schema);
    return path.join(directory, ".fluxfast");
  }

  function generatedBytes(directory: string): Record<string, string> {
    return Object.fromEntries(fs.readdirSync(directory).sort().map(file => [
      file, fs.readFileSync(path.join(directory, file), "utf8"),
    ]));
  }

  it.each([[], ["--help"], ["-h"], ["generate", "--help"]].map(args => ({ args })))("prints help without inspecting or changing a project ($args)", ({ args }) => {
    expect(runCodegenCli(args, io)).toBe(0);
    expect(stdout.join("\n")).toContain("fluxfast-codegen generate [--adapter next|react] [--check] [--schema-file PATH]");
    expect(stdout.join("\n")).toContain("Supported adapters: next, react");
    expect(stdout.join("\n")).toContain("default: next");
    expect(stderr).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(["init", "doctor", "unknown"])("rejects unsupported command %s", command => {
    expect(runCodegenCli([command], io)).toBe(2);
    expect(stderr.join("\n")).toContain("Unknown command:");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([
    ["--unknown"], ["--check", "--check"], ["--schema-file"],
    ["--schema-file", ""], ["--schema-file", "--check"],
    ["--schema-file", "first.json", "--schema-file", "second.json"],
    ["--adapter"], ["--adapter", ""], ["--adapter", "--check"],
    ["--adapter", "next", "--adapter", "next"], ["--adapter=next"],
    ["--help", "--unknown"], ["unexpected.json"],
  ].map(args => ({ args })))("rejects invalid generate options before touching the project ($args)", ({ args }) => {
    expect(runCodegenCli(["generate", ...args], io)).toBe(2);
    expect(stderr.join("\n")).toContain("Usage:");
    expect(stdout).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(["vite", "__proto__", "constructor", "toString", "NEXT", "React"])("fails closed on unsupported adapter %s", adapter => {
    expect(runCodegenCli(["generate", "--adapter", adapter], io)).toBe(2);
    expect(stderr.join("\n")).toContain("Unsupported adapter:");
    expect(stderr.join("\n")).toContain("Supported adapters: next");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(["root", "src"] as const)("generates a React allowlist without Next imports and preserves the other five artifacts in the %s layout", layout => {
    const output = source(layout);
    const args = ["generate", "--adapter", "react", "--schema-file", "backend-schema.json"];
    expect(runCodegenCli([...args, "--check"], io)).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
    expect(runCodegenCli(args, io)).toBe(0);
    const registry = fs.readFileSync(path.join(output, "pages.generated.ts"), "utf8");
    const nextRegistry = fs.readFileSync(path.join(fixture, "pages.generated.ts"), "utf8");
    expect(registry).toBe(nextRegistry.replace('"use client";\n', "").replaceAll("@fluxfast/next", "@fluxfast/react"));
    expect(registry).not.toContain("@fluxfast/next");
    expect(registry).not.toContain('"use client"');
    for (const [file, hash] of Object.entries(baseline.artifactDigests)) {
      if (file === "pages.generated.ts") continue;
      expect(createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("hex")).toBe(hash);
    }
    const before = generatedBytes(output);
    expect(runCodegenCli([...args, "--check"], io)).toBe(0);
    expect(generatedBytes(output)).toEqual(before);
    fs.writeFileSync(path.join(output, "pages.generated.ts"), "stale React registry\n");
    const stale = generatedBytes(output);
    expect(runCodegenCli([...args, "--check"], io)).toBe(1);
    expect(generatedBytes(output)).toEqual(stale);
    expect(runCodegenCli(args, io)).toBe(0);
    expect(generatedBytes(output)).toEqual(before);
  });

  it.each([
    [[], "root"], [["src"], "src"], [["app", "src"], "src"],
    [["pages", "src"], "src"], [["app", "pages"], "root"],
  ] as const)("uses React source layout without inheriting Next route-directory precedence for %j", (directories, layout) => {
    fs.writeFileSync(path.join(root, "package.json"), '{"private":true}');
    for (const directory of directories) fs.mkdirSync(path.join(root, directory), { recursive: true });
    expect(runCodegenCli(["generate", "--adapter", "react"], io)).toBe(0);
    const registry = path.join(root, layout === "src" ? "src" : "", ".fluxfast/pages.generated.ts");
    expect(fs.readFileSync(registry, "utf8")).toContain('from "@fluxfast/react"');
  });

  it("does not evaluate Vite configuration or install a framework to generate a React registry", () => {
    const output = source();
    fs.writeFileSync(path.join(root, "vite.config.ts"), 'throw new Error("Project code was executed");');
    expect(runCodegenCli(["generate", "--adapter", "react"], io)).toBe(0);
    expect(fs.existsSync(path.join(output, "pages.generated.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    expect(stderr).toEqual([]);
  });

  it("does not write any React artifacts for an invalid authoritative schema", () => {
    const output = source();
    const args = ["generate", "--adapter", "react", "--schema-file", "backend-schema.json"];
    expect(runCodegenCli(args, io)).toBe(0);
    const before = generatedBytes(output);
    fs.writeFileSync(path.join(root, "backend-schema.json"), "{}");
    expect(runCodegenCli(args, io)).toBe(1);
    expect(runCodegenCli([...args, "--check"], io)).toBe(1);
    expect(generatedBytes(output)).toEqual(before);
  });

  it.each(["root", "src"] as const)("preserves all six published artifact bytes and read-only checks in the %s layout", layout => {
    const output = source(layout);
    const args = ["generate", "--schema-file", "backend-schema.json"];
    expect(runCodegenCli([...args, "--check"], io)).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
    expect(runCodegenCli(args, io)).toBe(0);
    for (const [file, hash] of Object.entries(baseline.artifactDigests)) {
      expect(createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("hex")).toBe(hash);
    }
    const before = generatedBytes(output);
    stdout = [];
    expect(runCodegenCli([...args, "--adapter", "next", "--check"], io)).toBe(0);
    expect(stdout.at(-1)).toBe("✓ Generated FluxFast files are current.");
    expect(stdout).toContain("  Server validation remains authoritative.");
    expect(generatedBytes(output)).toEqual(before);

    const staleRegistry = path.join(output, "pages.generated.ts");
    fs.writeFileSync(staleRegistry, "stale registry\n");
    const stale = generatedBytes(output);
    expect(runCodegenCli([...args, "--check"], io)).toBe(1);
    expect(generatedBytes(output)).toEqual(stale);
    expect(runCodegenCli(args, io)).toBe(0);
    expect(generatedBytes(output)).toEqual(before);
  });

  it("reads an existing generated schema without rewriting its bytes", () => {
    const output = source();
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, "schema.generated.json"), schema);
    expect(runCodegenCli(["generate"], io)).toBe(0);
    expect(runCodegenCli(["generate", "--check"], io)).toBe(0);
    expect(fs.readFileSync(path.join(output, "schema.generated.json"), "utf8")).toBe(schema);
    expect(Object.keys(generatedBytes(output))).toHaveLength(6);
  });

  it("generates only the registry when no schema is available", () => {
    const output = source();
    expect(runCodegenCli(["generate"], io)).toBe(0);
    expect(fs.readdirSync(output)).toEqual(["pages.generated.ts"]);
    expect(runCodegenCli(["generate", "--check"], io)).toBe(0);
    expect(stdout.join("\n")).not.toContain("types from");
  });

  it("resolves an external schema relative to the invocation directory while finding its nearest project", () => {
    const output = source();
    const nested = path.join(root, "src/flux-pages/home");
    fs.renameSync(path.join(root, "backend-schema.json"), path.join(nested, "schema-input.json"));
    io.cwd = nested;
    expect(runCodegenCli(["generate", "--adapter", "next", "--schema-file", "schema-input.json"], io)).toBe(0);
    expect(fs.readFileSync(path.join(output, "schema.generated.json"), "utf8")).toBe(schema);
    expect(fs.readFileSync(path.join(output, "pages.generated.ts"), "utf8")).toBe(fs.readFileSync(path.join(fixture, "pages.generated.ts"), "utf8"));
  });

  it.each([
    [[], "root"], [["src"], "src"], [["app", "src"], "root"],
    [["src/app", "app"], "src"], [["pages", "src"], "root"],
    [["src/pages", "pages"], "src"], [["app", "src/pages"], "root"],
  ] as const)("matches the existing Next layout fallback for %j", (directories, layout) => {
    fs.writeFileSync(path.join(root, "package.json"), '{"private":true}');
    for (const directory of directories) fs.mkdirSync(path.join(root, directory), { recursive: true });
    expect(runCodegenCli(["generate", "--check"], io)).toBe(1);
    const output = path.join(root, layout === "src" ? "src" : "", ".fluxfast");
    expect(fs.existsSync(output)).toBe(false);
    expect(runCodegenCli(["generate"], io)).toBe(0);
    expect(fs.existsSync(path.join(output, "pages.generated.ts"))).toBe(true);
  });

  it("reports unsupported validators consistently during generation and checking", () => {
    const output = source();
    const manifest = JSON.parse(schema);
    manifest.resources.tags = { schema: { type: "array", items: { type: "string" }, uniqueItems: true } };
    fs.writeFileSync(path.join(root, "backend-schema.json"), JSON.stringify(manifest));
    const args = ["generate", "--schema-file", "backend-schema.json"];
    expect(runCodegenCli(args, io)).toBe(0);
    expect(stdout.join("\n")).toContain("TagsResource cannot receive a client validator");
    expect(stdout.join("\n")).toContain("Server validation remains authoritative");
    expect(fs.readFileSync(path.join(output, "validators.generated.ts"), "utf8")).not.toContain("export const TagsResourceValidator");
    stdout = [];
    expect(runCodegenCli([...args, "--check"], io)).toBe(0);
    expect(stdout.join("\n")).toContain("TagsResource cannot receive a client validator");
    expect(stdout.join("\n")).toContain("Generated FluxFast files are current");
  });

  it("leaves all existing artifacts unchanged when an external schema is invalid", () => {
    const output = source();
    const args = ["generate", "--schema-file", "backend-schema.json"];
    expect(runCodegenCli(args, io)).toBe(0);
    const before = generatedBytes(output);
    fs.writeFileSync(path.join(root, "backend-schema.json"), "{}");
    expect(runCodegenCli(args, io)).toBe(1);
    expect(runCodegenCli([...args, "--check"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("Invalid schema manifest");
    expect(generatedBytes(output)).toEqual(before);
  });

  it("fails on a missing external schema without creating the output directory", () => {
    const output = source();
    expect(runCodegenCli(["generate", "--schema-file", "missing.json"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("ENOENT");
    expect(fs.existsSync(output)).toBe(false);
  });

  it.each(["[", "[]", "null", '"invalid"'])("rejects malformed or non-object package metadata (%s)", packageJson => {
    fs.writeFileSync(path.join(root, "package.json"), packageJson);
    expect(runCodegenCli(["generate"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("package.json");
    expect(fs.readdirSync(root)).toEqual(["package.json"]);
  });

  it("never evaluates project configuration while detecting layout or compiling", () => {
    const output = source();
    fs.writeFileSync(path.join(root, "next.config.cjs"), 'throw new Error("Project code was executed");');
    expect(runCodegenCli(["generate", "--schema-file", "backend-schema.json"], io)).toBe(0);
    expect(fs.existsSync(path.join(output, "types.generated.ts"))).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("rejects a symlinked output directory during generation and read-only checks", () => {
    const output = source();
    const external = path.join(root, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "pages.generated.ts"), "external content\n");
    fs.symlinkSync(external, output, process.platform === "win32" ? "junction" : "dir");
    const args = ["generate", "--schema-file", "backend-schema.json"];
    expect(runCodegenCli(args, io)).toBe(1);
    expect(runCodegenCli([...args, "--check"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("symbolic link");
    expect(generatedBytes(external)).toEqual({ "pages.generated.ts": "external content\n" });
  });
});
