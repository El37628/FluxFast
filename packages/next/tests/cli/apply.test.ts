import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyInitPlan } from "../../src/cli/apply";
import {
  desiredCatchAllPath,
  desiredHealthRoutePath,
  desiredHomePagePath,
  desiredTransportRoutePath,
} from "../../src/cli/files";
import { changedOperations, createInitPlan } from "../../src/cli/init";
import { detectFluxProject } from "../../src/cli/project";
import { createTestProject, writeTestFile } from "./helpers";

describe("FluxFast init plan application", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-apply-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a plan, generates the registry, and is idempotent", () => {
    createTestProject(tmpDir);
    const originalPage = writeTestFile(
      tmpDir,
      "src/app/page.tsx",
      'import Image from "next/image";\nimport styles from "./page.module.css";\nexport default function Home() { return <Image src="/next.svg" alt="Next" />; }\n'
    );
    writeTestFile(tmpDir, "src/app/page.module.css", ".page {}\n");
    writeTestFile(
      tmpDir,
      "next.config.ts",
      "const nextConfig = {};\nexport default nextConfig;\n"
    );
    let project = detectFluxProject(tmpDir);

    const result = applyInitPlan(createInitPlan(project), { logRegistry: false });

    expect(result.changed).toBeGreaterThan(0);
    expect(fs.existsSync(originalPage)).toBe(false);
    expect(fs.readFileSync(desiredHomePagePath(project), "utf8")).toContain(
      '"use client";'
    );
    expect(fs.readFileSync(desiredCatchAllPath(project), "utf8")).toContain(
      "createFluxNextPage"
    );
    expect(fs.readFileSync(desiredHealthRoutePath(project), "utf8")).toContain(
      "createFluxHealthHandler"
    );
    expect(fs.readFileSync(desiredTransportRoutePath(project), "utf8")).toContain(
      "createFluxTransportHandler"
    );
    expect(fs.readFileSync(project.configPath, "utf8")).toContain(
      "defineFluxConfig"
    );
    expect(fs.readFileSync(project.registryPath, "utf8")).toContain(
      '"home/index"'
    );
    expect(fs.readFileSync(path.join(tmpDir, "next.config.ts"), "utf8")).toContain(
      "export default withFluxFast(nextConfig);"
    );

    project = detectFluxProject(tmpDir);
    const secondPlan = createInitPlan(project);
    expect(changedOperations(secondPlan)).toEqual([]);
    expect(() =>
      applyInitPlan(secondPlan, { logRegistry: false })
    ).not.toThrow();
  });

  it("rolls prior writes back when registry generation fails", () => {
    createTestProject(tmpDir);
    const originalConfig =
      "const nextConfig = {};\nexport default nextConfig;\n";
    const nextConfigPath = writeTestFile(
      tmpDir,
      "next.config.ts",
      originalConfig
    );
    writeTestFile(
      tmpDir,
      'src/flux-pages/unsafe";globalThis.changed=true;.tsx',
      "export default null;\n"
    );
    const project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);

    expect(() => applyInitPlan(plan, { logRegistry: false })).toThrow(
      /unsupported characters/
    );
    expect(fs.existsSync(project.configPath)).toBe(false);
    expect(fs.existsSync(desiredCatchAllPath(project))).toBe(false);
    expect(fs.existsSync(desiredHealthRoutePath(project))).toBe(false);
    expect(fs.existsSync(desiredTransportRoutePath(project))).toBe(false);
    expect(fs.existsSync(desiredHomePagePath(project))).toBe(false);
    expect(fs.existsSync(project.registryPath)).toBe(false);
    expect(fs.readFileSync(nextConfigPath, "utf8")).toBe(originalConfig);
  });

  it("rejects source changes made after planning before writing anything", () => {
    createTestProject(tmpDir);
    const configPath = writeTestFile(
      tmpDir,
      "next.config.ts",
      "const nextConfig = {};\nexport default nextConfig;\n"
    );
    const project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);
    fs.writeFileSync(configPath, "export default { changed: true };\n", "utf8");

    expect(() => applyInitPlan(plan, { logRegistry: false })).toThrow(
      /changed after FluxFast analyzed it/
    );
    expect(fs.existsSync(project.configPath)).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(
      "export default { changed: true };\n"
    );
  });

  it("refuses to follow a generated route through a symlink outside the project", () => {
    createTestProject(tmpDir);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-outside-test-"));
    fs.rmSync(path.join(tmpDir, "src/app"), { recursive: true });
    fs.symlinkSync(outside, path.join(tmpDir, "src/app"), "dir");
    const project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);

    try {
      expect(() => applyInitPlan(plan, { logRegistry: false })).toThrow(
        /outside the project root/
      );
      expect(fs.existsSync(project.configPath)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
