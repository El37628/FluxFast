import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runViteCli, type ViteCliIo } from "../src/cli";
import { projectAt, HOST_CONFIG, HOST_SCRIPTS, HOST_TEMPLATE } from "../src/project";
import { applySetup, planSetup } from "../src/setup";
import { mergeAgentBlock } from "../src/agent-knowledge";

const baseline = path.resolve(__dirname, "../../../tests/fixtures/adapter-baseline-v1.1.0");
const schema = fs.readFileSync(path.join(baseline, "schema.generated.json"), "utf8");
const declarations = { "@fluxfast/vite": "^1.1.0", react: "^19.3.0", "react-dom": "^19.3.0", vite: "7.3.6" };

describe("React/Vite installed-only initialization and generation", () => {
  let root: string;
  let io: ViteCliIo;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-vite-init-"));
    stdout = []; stderr = [];
    io = { cwd: root, stdout: message => stdout.push(message), stderr: message => stderr.push(message) };
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  function write(file: string, content: string): void {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
  }
  function source(layout: "src" | "root" = "src", typescript = true): string {
    write("package.json", JSON.stringify({ private: true, dependencies: declarations,
      scripts: { dev: "vite --host", build: "custom-build", start: "custom-start", test: "custom-test" } }, null, 2) + "\n");
    if (layout === "src") fs.mkdirSync(path.join(root, "src"));
    if (typescript) write("tsconfig.json", '{"compilerOptions":{"jsx":"react-jsx"}}');
    write("index.html", "<main>User SPA entry</main>");
    write(layout === "src" ? "src/main.tsx" : "main.jsx", "// Original SPA application\n");
    return layout === "src" ? "src/.fluxfast" : ".fluxfast";
  }
  // Reads bytes/mtime without following links, so read-only and preservation
  // checks include all existing user and generated files, not just known names.
  function snapshot(): Record<string, unknown> {
    const files: Record<string, unknown> = {};
    const visit = (directory: string) => {
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        const relative = path.relative(root, file);
        if (stat.isSymbolicLink()) files[relative] = { link: fs.readlinkSync(file) };
        else if (stat.isDirectory()) visit(file);
        else files[relative] = { bytes: fs.readFileSync(file).toString("base64"), mtime: stat.mtimeMs, mode: stat.mode };
      }
    };
    visit(root); return files;
  }

  it.each(["src", "root"] as const)("initializes the %s layout without changing SPA files, configuration, scripts or user instructions", async layout => {
    const generated = source(layout);
    write("vite.config.ts", 'throw new Error("Config must never execute during setup");\n');
    write("AGENTS.md", "# Existing agent rules\r\nKeep these.\r\n");
    write("CLAUDE.md", "Existing Claude rules without final newline");
    const before = snapshot();
    expect(await runViteCli(["init", "--yes"], io)).toBe(0);
    expect(stderr).toEqual([]);
    for (const name of ["index.html", layout === "src" ? "src/main.tsx" : "main.jsx", "vite.config.ts", "tsconfig.json"]) {
      expect(snapshot()[name]).toEqual(before[name]);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.scripts).toEqual({ dev: "vite --host", build: "custom-build", start: "custom-start", test: "custom-test", ...HOST_SCRIPTS });
    const config = fs.readFileSync(path.join(root, HOST_CONFIG), "utf8");
    expect(config).toContain('import original from "./vite.config.ts"');
    expect(config).toContain('typeof original === "function" ? original(context) : original');
    expect(config).toContain(`${generated}/pages.generated.ts`);
    const registry = fs.readFileSync(path.join(root, generated, "pages.generated.ts"), "utf8");
    expect(registry).toContain("home/index");
    expect(registry).toContain("@fluxfast/react");
    expect(registry).not.toContain("@fluxfast/next");
    expect(registry).not.toContain('"use client"');
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Existing agent rules\r\nKeep these.\r\n")).toBe(true);
    expect(agents.replaceAll("\r\n", "")).not.toContain("\n");
    expect(agents).toContain(`@${generated}/agent-knowledge.md`);
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").startsWith("Existing Claude rules without final newline\n\n")).toBe(true);
    const knowledge = fs.readFileSync(path.join(root, generated, "agent-knowledge.md"), "utf8");
    for (const text of ["FastAPI owns", "scope.user(id)", "```python", "```tsx", "<h1>Hello</h1>", "fluxfast-vite generate --check", "FLUXFAST_BACKEND_URL", "never put it in a"]) expect(knowledge).toContain(text);
    expect(await runViteCli(["init", "--check"], io)).toBe(0);
    expect(await runViteCli(["doctor"], io)).toBe(0);
    const initialized = snapshot();
    expect(await runViteCli(["init"], io)).toBe(0);
    expect(snapshot()).toEqual(initialized);
  });

  it("creates a JSX starter without inventing TypeScript tooling", async () => {
    source("src", false);
    expect(await runViteCli(["init"], io)).toBe(0);
    expect(fs.existsSync(path.join(root, "src/flux-pages/home/index.jsx"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tsconfig.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src/flux-pages/home/index.tsx"))).toBe(false);
  });

  it("dry-runs and checks without creating files or evaluating a throwing config", async () => {
    source(); write("vite.config.mjs", 'throw new Error("Forbidden config evaluation");');
    const before = snapshot();
    expect(await runViteCli(["init", "--dry-run"], io)).toBe(0);
    expect(stdout.join("\n")).toContain(`Would update ${HOST_CONFIG}`);
    expect(snapshot()).toEqual(before);
    expect(await runViteCli(["init", "--check"], io)).toBe(1);
    expect(await runViteCli(["doctor"], io)).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(stderr.join("\n")).not.toContain("Forbidden config evaluation");
  });

  it("refreshes only the bounded knowledge reference and generated guide", async () => {
    const generated = source();
    expect(await runViteCli(["init"], io)).toBe(0);
    write("AGENTS.md", "prefix\n" + fs.readFileSync(path.join(root, "AGENTS.md"), "utf8") + "suffix\n");
    write(generated + "/agent-knowledge.md", "<!-- GENERATED BY FLUXFAST. Run `fluxfast-vite init` to refresh this file. -->\nold guide\n");
    write("src/flux-pages/home/index.tsx", "export default () => <h1>Custom home</h1>;\n");
    const config = fs.readFileSync(path.join(root, HOST_CONFIG), "utf8") + "// Custom config note\n";
    write(HOST_CONFIG, config);
    const before = snapshot();
    expect(await runViteCli(["init"], io)).toBe(0);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").startsWith("prefix\n")).toBe(true);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").endsWith("suffix\n")).toBe(true);
    expect(snapshot()[HOST_CONFIG]).toEqual(before[HOST_CONFIG]);
    expect(snapshot()["src/flux-pages/home/index.tsx"]).toEqual(before["src/flux-pages/home/index.tsx"]);
    expect(fs.readFileSync(path.join(root, generated, "agent-knowledge.md"), "utf8")).toContain("React/Vite agent knowledge");
    expect(await runViteCli(["doctor"], io)).toBe(0);
  });

  it.each(["AGENTS.md", "CLAUDE.md"])("rejects malformed %s blocks even with force, before any writes", async file => {
    source(); write(file, "User instructions\n<!-- fluxfast-agent-knowledge:start -->\n");
    const before = snapshot();
    expect(await runViteCli(["init", "--force"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("Malformed or duplicate");
    expect(snapshot()).toEqual(before);
  });

  it.each([HOST_CONFIG, HOST_TEMPLATE, "src/.fluxfast/agent-knowledge.md"])("requires explicit force for user-owned reserved %s", async file => {
    source(); write(file, "User-owned reserved content\n");
    const before = snapshot();
    expect(await runViteCli(["init"], io)).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(await runViteCli(["init", "--force"], io)).toBe(0);
    expect(fs.readFileSync(path.join(root, file), "utf8")).not.toContain("User-owned reserved content");
  });

  it.each(["src", "src/flux-pages", "src/.fluxfast", HOST_CONFIG, "AGENTS.md", "src/.fluxfast/schema.generated.json", "src/.fluxfast/types.generated.ts"])("rejects an output/input symlink at %s before writing", async file => {
    source();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-vite-outside-"));
    try {
      const isDirectory = ["src", "src/flux-pages", "src/.fluxfast"].includes(file);
      const target = isDirectory ? outside : path.join(outside, "owned-file");
      if (!isDirectory) fs.writeFileSync(target, "outside user data");
      if (file === "src") fs.renameSync(path.join(root, "src"), path.join(root, "original-src"));
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.symlinkSync(target, path.join(root, file), isDirectory ? (process.platform === "win32" ? "junction" : "dir") : "file");
      const before = snapshot();
      expect(await runViteCli(["init", "--force"], io)).toBe(1);
      expect(stderr.join("\n")).toContain("symlink");
      expect(snapshot()).toEqual(before);
      expect(fs.readdirSync(outside)).toEqual(isDirectory ? [] : ["owned-file"]);
      if (!isDirectory) expect(fs.readFileSync(target, "utf8")).toBe("outside user data");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it("fails closed on ambiguous source configuration without executing either config", async () => {
    source(); write("vite.config.ts", "throw new Error('one')"); write("vite.config.mjs", "throw new Error('two')");
    const before = snapshot();
    expect(await runViteCli(["init"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("Multiple source Vite configs");
    expect(snapshot()).toEqual(before);
  });

  it.each(["@fluxfast/vite", "react", "react-dom", "vite"])("requires declared %s instead of downloading it", async missing => {
    source(); const dependencies = { ...declarations }; delete dependencies[missing as keyof typeof declarations];
    write("package.json", JSON.stringify({ dependencies }));
    const before = snapshot();
    expect(await runViteCli(["init"], io)).toBe(1);
    expect(stderr.join("\n")).toContain(`Declare and install ${missing}`);
    expect(snapshot()).toEqual(before);
  });

  it.each([{ dependencies: { ...declarations, "@fluxfast/next": "^1.1.0" } }, { dependencies: [] },
    { dependencies: { ...declarations, vite: null } }, { dependencies: declarations, scripts: { "fluxfast:dev": "custom-command" } },
    { dependencies: declarations, scripts: [] }])("rejects malformed, mixed-adapter or conflicting script manifests before writes (%j)", async manifest => {
    source(); write("package.json", JSON.stringify(manifest)); const before = snapshot();
    expect(await runViteCli(["init", "--force"], io)).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it("discovers a frontend from a nested working directory", async () => {
    source(); io.cwd = path.join(root, "src");
    expect(await runViteCli(["init"], io)).toBe(0);
    expect(fs.existsSync(path.join(root, HOST_CONFIG))).toBe(true);
    expect(fs.existsSync(path.join(root, "src", HOST_CONFIG))).toBe(false);
  });

  it("compiles the same six typed artifacts as Codegen and checks drift without writes", async () => {
    const generated = source(); write("backend-schema.json", schema);
    expect(await runViteCli(["init"], io)).toBe(0);
    const args = ["generate", "--schema-file", "backend-schema.json"];
    const before = snapshot();
    expect(await runViteCli([...args, "--check"], io)).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(await runViteCli(args, io)).toBe(0);
    for (const name of ["schema.generated.json", "types.generated.ts", "validators.generated.ts", "routes.generated.ts", "mutations.generated.ts"]) {
      expect(fs.readFileSync(path.join(root, generated, name), "utf8")).toBe(fs.readFileSync(path.join(baseline, name), "utf8"));
    }
    const current = snapshot();
    expect(await runViteCli([...args, "--check"], io)).toBe(0);
    expect(snapshot()).toEqual(current);
    write(generated + "/types.generated.ts", "stale\n"); const stale = snapshot();
    expect(await runViteCli(["doctor"], io)).toBe(1);
    expect(await runViteCli(["generate", "--check"], io)).toBe(1);
    expect(snapshot()).toEqual(stale);
    expect(await runViteCli(["generate"], io)).toBe(0);
    expect(await runViteCli(["doctor"], io)).toBe(0);
  });

  it("validates malformed schema before changing existing scaffold or generated files", async () => {
    const generated = source(); write(generated + "/schema.generated.json", '{"schema":"bad"}');
    const before = snapshot();
    for (const args of [["init"], ["generate"], ["generate", "--check"], ["doctor"]]) {
      expect(await runViteCli(args, io)).toBe(1);
      expect(snapshot()).toEqual(before);
    }
    expect(stderr.join("\n")).toContain("Invalid schema manifest");
  });

  it("does not generate React artifacts into a declared Next frontend", async () => {
    source(); write("package.json", JSON.stringify({ dependencies: { ...declarations, "@fluxfast/next": "^1.1.0" } }));
    const before = snapshot();
    expect(await runViteCli(["generate"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("mixing Next and Vite adapters");
    expect(snapshot()).toEqual(before);
  });

  it("rejects a stale plan instead of overwriting an intervening user edit", () => {
    source(); const project = projectAt(root); const plan = planSetup(project);
    write("AGENTS.md", "New user instruction\n"); const before = snapshot();
    expect(() => applySetup(plan)).toThrow("changed after planning");
    expect(snapshot()).toEqual(before);
  });

  it("restores scaffold bytes, file modes and mtimes after a later generation write fails", () => {
    const generated = source();
    write("AGENTS.md", "Existing user instructions\n");
    fs.chmodSync(path.join(root, "AGENTS.md"), 0o600);
    write(generated + "/pages.generated.ts", "Previous registry\n");
    const project = projectAt(root); const plan = planSetup(project); const before = snapshot();
    const original = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("pages.generated.ts")) throw Object.assign(new Error("Injected filesystem failure"), { code: "EIO" });
      return original(from, to);
    });
    expect(() => applySetup(plan)).toThrow("Injected filesystem failure"); spy.mockRestore();
    const after = snapshot() as Record<string, { bytes: string; mtime: number; mode: number }>;
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const [name, old] of Object.entries(before)) {
      const previous = old as { bytes: string; mtime: number; mode: number };
      expect(after[name].bytes).toBe(previous.bytes);
      expect(after[name].mode).toBe(previous.mode);
      // utimes uses floating-point seconds; preserve metadata within filesystem precision.
      expect(Math.abs(after[name].mtime - previous.mtime)).toBeLessThan(1);
    }
    expect(fs.existsSync(path.join(root, "src/flux-pages"))).toBe(false);
    expect(fs.readdirSync(path.join(root, generated))).toEqual(["pages.generated.ts"]);
  });

  it("restores an earlier replaced artifact when a later typed artifact write fails", () => {
    const generated = source();
    write(generated + "/schema.generated.json", schema);
    write(generated + "/pages.generated.ts", "Old registry\n");
    write(generated + "/types.generated.ts", "Old types\n");
    const plan = planSetup(projectAt(root));
    const oldRegistry = fs.readFileSync(path.join(root, generated, "pages.generated.ts"));
    const original = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("types.generated.ts")) throw new Error("Later artifact failure");
      return original(from, to);
    });
    expect(() => applySetup(plan)).toThrow("Later artifact failure"); spy.mockRestore();
    expect(fs.readFileSync(path.join(root, generated, "pages.generated.ts"))).toEqual(oldRegistry);
    expect(fs.readFileSync(path.join(root, generated, "types.generated.ts"), "utf8")).toBe("Old types\n");
    expect(fs.readdirSync(path.join(root, generated)).sort()).toEqual(["pages.generated.ts", "schema.generated.json", "types.generated.ts"]);
    expect(fs.existsSync(path.join(root, HOST_CONFIG))).toBe(false);
  });

  it("restores metadata even when Codegen replaced an artifact with identical bytes", async () => {
    const generated = source(); write("backend-schema.json", schema);
    expect(await runViteCli(["generate", "--schema-file", "backend-schema.json"], io)).toBe(0);
    const file = path.join(root, generated, "types.generated.ts");
    fs.chmodSync(file, 0o600); fs.utimesSync(file, 1_600_000_000, 1_600_000_000);
    const previous = fs.statSync(file), bytes = fs.readFileSync(file);
    const plan = planSetup(projectAt(root)); const original = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("validators.generated.ts")) throw new Error("Later unchanged artifact failure");
      return original(from, to);
    });
    expect(() => applySetup(plan)).toThrow("Later unchanged artifact failure"); spy.mockRestore();
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.statSync(file).mtimeMs).toBe(previous.mtimeMs);
    expect(fs.statSync(file).mode).toBe(previous.mode);
  });

  it("reports an incomplete rollback instead of silently claiming restoration", () => {
    source(); write("AGENTS.md", "User instructions\n");
    const plan = planSetup(projectAt(root)); const original = fs.renameSync;
    let generationFailed = false;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("pages.generated.ts")) { generationFailed = true; throw new Error("Generation write failure"); }
      if (generationFailed && String(to).endsWith("AGENTS.md")) throw new Error("Rollback write failure");
      return original(from, to);
    });
    expect(() => applySetup(plan)).toThrow("rollback was incomplete"); spy.mockRestore();
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").startsWith("User instructions\n")).toBe(true);
  });

  it.each([["init", "--check", "--yes"], ["init", "--yes", "--yes"], ["init", "--unknown"],
    ["generate", "--schema-file"], ["generate", "--schema-file", "--check"], ["generate", "--check", "--check"],
    ["doctor", "--force"], ["start", "--config", "vite.config.ts"], ["build", "--port", "3000"]])("rejects invalid CLI options before project inspection (%j)", async args => {
    expect(await runViteCli(args, io)).toBe(2);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("bounded AI-agent knowledge references", () => {
  it.each([
    "<!-- fluxfast-agent-knowledge:end -->", "<!-- fluxfast-agent-knowledge:end --><!-- fluxfast-agent-knowledge:start -->",
    "<!-- fluxfast-agent-knowledge:start --><!-- fluxfast-agent-knowledge:start --><!-- fluxfast-agent-knowledge:end -->",
    "<!-- fluxfast-agent-knowledge:start --><!-- fluxfast-agent-knowledge:end --><!-- fluxfast-agent-knowledge:end -->",
  ])("refuses malformed or duplicate managed blocks (%s)", content => {
    expect(() => mergeAgentBlock(content, "src/.fluxfast/agent-knowledge.md")).toThrow("Malformed or duplicate");
  });
});
