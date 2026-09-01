import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/index";
import { desiredCatchAllPath, renderCatchAll } from "../../src/cli/files";
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
    expect(stdout.join("\n")).toContain("--force");
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

  it("repairs an invalid generated catch-all only when forced", () => {
    createTestProject(tmpDir);
    expect(runCli(["init"], io)).toBe(0);
    const project = detectFluxProject(tmpDir);
    const catchAllPath = desiredCatchAllPath(project);
    fs.writeFileSync(catchAllPath, "export default null;\n", "utf8");

    stdout = [];
    expect(runCli(["init"], io)).toBe(1);
    expect(fs.readFileSync(catchAllPath, "utf8")).toBe("export default null;\n");

    stdout = [];
    expect(runCli(["init", "--force"], io)).toBe(0);
    expect(fs.readFileSync(catchAllPath, "utf8")).toBe(renderCatchAll(project));
    expect(stdout.join("\n")).toContain("--force was used");
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

  it("generates schema-backed types, routes, and mutations when a manifest exists", () => {
    createTestProject(tmpDir);
    writeTestFile(
      tmpDir,
      "src/.fluxfast/schema.generated.json",
      `${JSON.stringify({
        schema: "fluxfast-schema/1",
        producer: "0.6.0",
        fingerprint: "e".repeat(64),
        resources: {
          rooms: {
            schema: {
              type: "array",
              items: { type: "string" }
            }
          }
        },
        pages: [
          {
            name: "hotel_rooms",
            path: "/hotels/{hotel_id}/rooms",
            parameters: [
              {
                name: "hotel_id",
                location: "path",
                required: true,
                schema: { type: "integer" }
              }
            ]
          }
        ],
        mutations: [
          {
            name: "create_room",
            path: "/rooms",
            method: "POST",
            parameters: [],
            body: {
              type: "object",
              properties: { number: { type: "integer" } },
              required: ["number"]
            }
          }
        ]
      }, null, 2)}\n`
    );

    expect(runCli(["generate"], io)).toBe(0);

    const generatedDir = path.join(tmpDir, "src/.fluxfast");
    expect(
      fs.readFileSync(path.join(generatedDir, "types.generated.ts"), "utf8")
    ).toContain('rooms: "rooms"');
    expect(
      fs.readFileSync(path.join(generatedDir, "routes.generated.ts"), "utf8")
    ).toContain("hotelRooms:");
    expect(
      fs.readFileSync(path.join(generatedDir, "mutations.generated.ts"), "utf8")
    ).toContain("createRoom:");
    expect(stdout.join("\n")).toContain(
      "Generated FluxFast types from src/.fluxfast/schema.generated.json"
    );
  });

  it("does not partially update generated files when the manifest is invalid", () => {
    createTestProject(tmpDir);
    const project = detectFluxProject(tmpDir);
    writeTestFile(tmpDir, "src/flux-pages/home.tsx", "export default null;\n");
    writeTestFile(tmpDir, "src/.fluxfast/pages.generated.ts", "previous registry\n");
    writeTestFile(tmpDir, "src/.fluxfast/schema.generated.json", "{}\n");

    expect(runCli(["generate"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("Invalid schema manifest");
    expect(fs.readFileSync(project.registryPath, "utf8")).toBe(
      "previous registry\n"
    );
    expect(
      fs.existsSync(path.join(project.generatedDir, "types.generated.ts"))
    ).toBe(false);
  });

  it("checks an initialized project without writing", () => {
    createTestProject(tmpDir);
    expect(runCli(["init"], io)).toBe(0);
    const project = detectFluxProject(tmpDir);
    const registryBefore = fs.readFileSync(project.registryPath, "utf8");
    stdout = [];

    expect(runCli(["init", "--check"], io)).toBe(0);
    expect(stdout.join("\n")).toContain("FluxFast Configuration Check");
    expect(stdout.join("\n")).toContain("FluxFast is configured correctly.");
    expect(fs.readFileSync(project.registryPath, "utf8")).toBe(registryBefore);
  });

  it("returns a failing check with an init recommendation", () => {
    createTestProject(tmpDir);

    expect(runCli(["init", "--check"], io)).toBe(1);
    expect(stdout.join("\n")).toContain("FluxFast Configuration Check");
    expect(stdout.join("\n")).toContain("npx fluxfast init");
    expect(fs.existsSync(path.join(tmpDir, "src/.fluxfast/pages.generated.ts"))).toBe(
      false
    );
  });

  it("runs doctor with grouped diagnostics and registered pages", () => {
    createTestProject(tmpDir);
    expect(runCli(["init"], io)).toBe(0);
    stdout = [];

    expect(runCli(["doctor"], io)).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("FluxFast Doctor");
    expect(output).toContain("Environment");
    expect(output).toContain("Configuration");
    expect(output).toContain("home/index");
    expect(output).toContain("No problems found.");
  });

  it("doctor detects stale state without repairing it", () => {
    createTestProject(tmpDir);
    expect(runCli(["init"], io)).toBe(0);
    const project = detectFluxProject(tmpDir);
    const registryBefore = fs.readFileSync(project.registryPath, "utf8");
    writeTestFile(
      tmpDir,
      "src/flux-pages/rooms/index.tsx",
      "export default function Rooms() { return null; }\n"
    );
    stdout = [];

    expect(runCli(["doctor"], io)).toBe(1);
    expect(stdout.join("\n")).toContain("Registry appears stale");
    expect(stdout.join("\n")).toContain("npx fluxfast generate");
    expect(fs.readFileSync(project.registryPath, "utf8")).toBe(registryBefore);
  });
});
