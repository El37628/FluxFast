import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyInitPlan } from "../../src/cli/apply";
import { validateFluxProject } from "../../src/cli/diagnostics";
import { desiredCatchAllPath } from "../../src/cli/files";
import { createInitPlan } from "../../src/cli/init";
import { detectFluxProject } from "../../src/cli/project";
import { generateFluxFastProject } from "../../src/generate";
import type { FluxProjectInfo } from "../../src/cli/types";
import {
  createTestProject,
  writeSchemaManifest,
  writeTestFile,
} from "./helpers";

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

  function initializeTyped(
    overrides: Record<string, unknown> = {}
  ): FluxProjectInfo {
    const project = initialize();
    writeSchemaManifest(tmpDir, overrides);
    generateFluxFastProject({
      pagesDir: project.fluxPagesDir,
      outputFile: project.registryPath,
      generatedDir: project.generatedDir,
      log: false,
    });
    return detectFluxProject(tmpDir);
  }

  function repeatedNestedSchema(depth: number): Record<string, unknown> {
    const definitions: Record<string, unknown> = {};
    for (let index = depth - 1; index >= 0; index -= 1) {
      const name = `NestedLevel${index}`;
      definitions[name] = index === depth - 1
        ? {
            title: name,
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          }
        : {
            title: name,
            type: "object",
            properties: {
              child: { $ref: `#/$defs/NestedLevel${index + 1}` },
              siblings: {
                type: "array",
                items: { $ref: `#/$defs/NestedLevel${index + 1}` },
              },
            },
            required: ["child", "siblings"],
          };
    }
    return {
      $defs: definitions,
      $ref: "#/$defs/NestedLevel0",
    };
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

  it("recommends force only for an invalid existing catch-all", () => {
    const project = initialize();
    fs.writeFileSync(
      desiredCatchAllPath(project),
      "export default null;\n",
      "utf8"
    );

    const report = validateFluxProject(detectFluxProject(tmpDir));

    expect(report.valid).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "config.catch-all",
        status: "fail",
        fix: "npx fluxfast init --force",
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

  it("reports a valid manifest, contract counts, and current generated types", () => {
    const report = validateFluxProject(initializeTyped(), {
      includeTypeDiagnostics: true,
    });

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "types.manifest",
          status: "pass",
          message: expect.stringContaining("fluxfast-schema/1 manifest found"),
        }),
        expect.objectContaining({
          id: "types.resources",
          status: "pass",
          message: "1 typed resource",
        }),
        expect.objectContaining({
          id: "types.routes",
          status: "pass",
          message: "1 page route",
        }),
        expect.objectContaining({
          id: "types.mutations",
          status: "pass",
          message: "1 mutation operation",
        }),
        expect.objectContaining({
          id: "types.generated",
          status: "pass",
          message: "Generated TypeScript is current",
        }),
      ])
    );
  });

  it("treats a missing schema manifest as a non-blocking type warning", () => {
    const project = initialize();
    const report = validateFluxProject(project, {
      includeTypeDiagnostics: true,
    });

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "types.manifest",
        section: "Types",
        status: "warning",
        message: expect.stringContaining("manifest was not found"),
      })
    );
    expect(
      fs.existsSync(path.join(project.generatedDir, "types.generated.ts"))
    ).toBe(false);
  });

  it("warns when generated types drift without rewriting them", () => {
    const project = initializeTyped();
    const typesPath = path.join(project.generatedDir, "types.generated.ts");
    const typesBefore = fs.readFileSync(typesPath, "utf8");
    writeSchemaManifest(tmpDir, { fingerprint: "f".repeat(64) });

    const report = validateFluxProject(detectFluxProject(tmpDir), {
      includeTypeDiagnostics: true,
    });

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "types.generated",
        status: "warning",
        message: expect.stringContaining("stale or missing"),
        fix: "npx fluxfast generate",
      })
    );
    expect(fs.readFileSync(typesPath, "utf8")).toBe(typesBefore);
  });

  it("warns about unsupported manifest versions without blocking runtime", () => {
    const project = initialize();
    writeSchemaManifest(tmpDir, { schema: "fluxfast-schema/3" });

    const report = validateFluxProject(detectFluxProject(tmpDir), {
      includeTypeDiagnostics: true,
    });

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "types.manifest",
        status: "warning",
        message: expect.stringContaining("version is unsupported"),
      })
    );
    expect(fs.readFileSync(project.registryPath, "utf8")).toContain(
      "home/index"
    );
  });

  it("warns when an unconstrained resource schema maps to unknown", () => {
    const report = validateFluxProject(
      initializeTyped({
        resources: {
          payload: { schema: {} },
        },
      }),
      { includeTypeDiagnostics: true }
    );

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "types.unknown",
        status: "warning",
        message: expect.stringContaining('Resource "payload"'),
      })
    );
  });

  it("warns when a referenced model contains an unconstrained schema", () => {
    const report = validateFluxProject(
      initializeTyped({
        resources: {
          payload: {
            schema: {
              $defs: {
                Payload: {
                  type: "object",
                  properties: { value: {} },
                  required: ["value"],
                },
              },
              $ref: "#/$defs/Payload",
            },
          },
        },
      }),
      { includeTypeDiagnostics: true }
    );

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "types.unknown",
        status: "warning",
        message: expect.stringContaining('Resource "payload"'),
      })
    );
  });

  it("checks deeply repeated references without expanding them inline", () => {
    const report = validateFluxProject(
      initializeTyped({
        resources: {
          nested: { schema: repeatedNestedSchema(24) },
        },
      }),
      { includeTypeDiagnostics: true }
    );

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "types.generated",
        status: "pass",
        message: "Generated TypeScript is current",
      })
    );
    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({ id: "types.unknown" })
    );
  });

  it("surfaces route identifier collisions as non-blocking type warnings", () => {
    const project = initialize();
    writeSchemaManifest(tmpDir, {
      pages: [
        {
          name: "room-types",
          path: "/rooms",
          parameters: [],
        },
        {
          name: "room_types",
          path: "/room-types",
          parameters: [],
        },
      ],
    });

    const report = validateFluxProject(detectFluxProject(tmpDir), {
      includeTypeDiagnostics: true,
    });

    expect(report.valid).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        id: "types.generated",
        status: "warning",
        message: expect.stringContaining("collides"),
      })
    );
    expect(fs.readFileSync(project.registryPath, "utf8")).toContain(
      "home/index"
    );
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
