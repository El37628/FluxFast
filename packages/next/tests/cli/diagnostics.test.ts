import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyInitPlan } from "../../src/cli/apply";
import { validateFluxProject } from "../../src/cli/diagnostics";
import { createInitPlan } from "../../src/cli/init";
import { detectFluxProject } from "../../src/cli/project";
import type { FluxProjectInfo } from "../../src/cli/types";
import { createTestProject, writeTestFile } from "./helpers";

describe("FluxFast project diagnostics", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-doctor-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function initialize(): FluxProjectInfo {
    createTestProject(tmpDir);
    const project = detectFluxProject(tmpDir);
    applyInitPlan(createInitPlan(project), { logRegistry: false });
    return detectFluxProject(tmpDir);
  }

  it("reports a healthy initialized project and its registered pages", () => {
    const report = validateFluxProject(initialize());

    expect(report.valid).toBe(true);
    expect(report.pages).toEqual(["home/index"]);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "environment.node", status: "pass" }),
        expect.objectContaining({ id: "package.next", status: "pass" }),
        expect.objectContaining({ id: "project.app-router", status: "pass" }),
        expect.objectContaining({ id: "config.fluxfast", status: "pass" }),
        expect.objectContaining({ id: "config.next", status: "pass" }),
        expect.objectContaining({ id: "config.catch-all", status: "pass" }),
        expect.objectContaining({ id: "registry.current", status: "pass" }),
      ])
    );
  });

  it("reports a missing FluxFast config", () => {
    const project = initialize();
    fs.unlinkSync(project.configPath);

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "config.fluxfast",
        status: "fail",
        fix: "npx fluxfast init",
      })
    );
  });

  it("detects a stale registry without changing it", () => {
    const project = initialize();
    const before = fs.readFileSync(project.registryPath, "utf8");
    writeTestFile(
      tmpDir,
      "src/flux-pages/rooms/index.tsx",
      '"use client";\nexport default function Rooms() { return null; }\n'
    );

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "registry.current",
        status: "fail",
        fix: "npx fluxfast generate",
      })
    );
    expect(fs.readFileSync(project.registryPath, "utf8")).toBe(before);
  });

  it("detects a root Next route that shadows FluxFast", () => {
    initialize();
    writeTestFile(
      tmpDir,
      "src/app/page.tsx",
      "export default function Shadow() { return null; }\n"
    );

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "routes.shadowing-root",
        status: "warning",
        blocksCheck: true,
      })
    );
  });

  it("reports unsupported package versions", () => {
    createTestProject(tmpDir, {
      dependencies: {
        "@fluxfast/next": "^0.1.0",
        next: "15.4.2",
        react: "18.3.1",
        "react-dom": "18.3.1",
      },
    });

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "package.next", status: "fail" }),
        expect.objectContaining({ id: "package.react", status: "fail" }),
        expect.objectContaining({ id: "package.react-dom", status: "fail" }),
      ])
    );
  });

  it("reports a missing @fluxfast/next package", () => {
    createTestProject(tmpDir, {
      dependencies: {
        next: "16.3.3",
        react: "19.0.0",
        "react-dom": "19.0.0",
      },
    });

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "package.fluxfast-next",
        status: "fail",
        fix: "npm install @fluxfast/next",
      })
    );
  });

  it("detects non-root Next routes that shadow FastAPI routes", () => {
    initialize();
    writeTestFile(
      tmpDir,
      "src/app/settings/page.tsx",
      "export default function Settings() { return null; }\n"
    );

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "routes.shadowing",
        status: "warning",
        message: expect.stringContaining('shadows FluxFast route "/settings"'),
      })
    );
  });

  it("reports duplicate page identifiers as invalid registration", () => {
    const project = initialize();
    writeTestFile(
      tmpDir,
      "src/flux-pages/rooms/index.tsx",
      "export default function Rooms() { return null; }\n"
    );
    writeTestFile(
      tmpDir,
      "src/flux-pages/rooms/index.jsx",
      "export default function DuplicateRooms() { return null; }\n"
    );

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "pages.valid",
        status: "fail",
        message: expect.stringContaining("Duplicate FluxFast page identifier"),
      })
    );
    expect(fs.readFileSync(project.registryPath, "utf8")).toContain("home/index");
  });

  it("does not create scaffolding while diagnosing an incomplete project", () => {
    createTestProject(tmpDir);
    const project = detectFluxProject(tmpDir);

    const report = validateFluxProject(project);

    expect(report.valid).toBe(false);
    expect(fs.existsSync(project.configPath)).toBe(false);
    expect(fs.existsSync(project.registryPath)).toBe(false);
  });
});
