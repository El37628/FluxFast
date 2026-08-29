import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/index";
import { detectFluxProject } from "../../src/cli/project";
import { createTestProject, writeTestFile } from "./helpers";

describe("FluxFast CLI", () => {
  let tmpDir: string;
  let stdout: string[];
  let stderr: string[];
  let io: CliIo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-cli-test-"));
    stdout = [];
    stderr = [];
    io = {
      cwd: tmpDir,
      stdout: message => stdout.push(message),
      stderr: message => stderr.push(message),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints help without a command", () => {
    expect(runCli([], io)).toBe(0);
    expect(stdout.join("\n")).toContain("fluxfast init");
    expect(stdout.join("\n")).toContain("fluxfast generate");
  });

  it("uses exit code 2 for unknown commands and options", () => {
    expect(runCli(["unknown"], io)).toBe(2);
    expect(stderr.join("\n")).toContain("Unknown command: unknown");

    stderr = [];
    expect(runCli(["init", "--mystery"], io)).toBe(2);
    expect(stderr.join("\n")).toContain("Unknown option: --mystery");
  });

  it("renders a dry run from the real init plan without writing", () => {
    createTestProject(tmpDir);
    writeTestFile(
      tmpDir,
      "next.config.ts",
      "const nextConfig = {};\nexport default nextConfig;\n"
    );

    expect(runCli(["init", "--dry-run"], io)).toBe(0);

    const output = stdout.join("\n");
    expect(output).toContain("FluxFast Setup — Dry Run");
    expect(output).toContain("Would create:");
    expect(output).toContain("src/fluxfast.config.ts");
    expect(output).toContain("Would modify:");
    expect(output).toContain("next.config.ts");
    expect(output).toContain("No files were changed.");
    expect(fs.existsSync(path.join(tmpDir, "src/fluxfast.config.ts"))).toBe(false);
  });

  it("initializes a project and generates its registry", () => {
    createTestProject(tmpDir);

    expect(runCli(["init", "--yes"], io)).toBe(0);

    const project = detectFluxProject(tmpDir);
    expect(fs.existsSync(project.configPath)).toBe(true);
    expect(fs.existsSync(project.registryPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "next.config.ts"))).toBe(true);
    expect(stdout.join("\n")).toContain("Ready.");

    stdout = [];
    expect(runCli(["init"], io)).toBe(0);
    expect(stdout.join("\n")).toContain("No scaffold changes required.");
  });

  it("leaves custom root pages untouched and returns an actionable failure", () => {
    createTestProject(tmpDir);
    const rootPage = writeTestFile(
      tmpDir,
      "src/app/page.tsx",
      "export default function Product() { return <h1>Product</h1>; }\n"
    );

    expect(runCli(["init", "--yes"], io)).toBe(1);
    expect(fs.existsSync(rootPage)).toBe(true);
    expect(stdout.join("\n")).toContain("Manual action required");
    expect(stdout.join("\n")).toContain("then remove");
  });

  it("runs explicit registry generation using the detected root layout", () => {
    createTestProject(tmpDir, { language: "javascript", layout: "root" });
    writeTestFile(
      tmpDir,
      "flux-pages/home/index.jsx",
      "export default function Home() { return null; }\n"
    );

    expect(runCli(["generate"], io)).toBe(0);
    expect(
      fs.readFileSync(path.join(tmpDir, ".fluxfast/pages.generated.ts"), "utf8")
    ).toContain('"home/index"');
    expect(stdout.join("\n")).toContain("Generated FluxFast registry");
  });
});
