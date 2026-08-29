import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desiredCatchAllPath, desiredHomePagePath, renderCatchAll } from "../../src/cli/files";
import { changedOperations, createInitPlan } from "../../src/cli/init";
import { detectFluxProject } from "../../src/cli/project";
import { createTestProject, writeTestFile } from "./helpers";

describe("FluxFast init planner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-init-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function operation(type: string, target?: string) {
    return createInitPlan(detectFluxProject(tmpDir)).operations.find(item => {
      if (item.type !== type) return false;
      if (!target) return true;
      return "path" in item
        ? item.path === target
        : "to" in item
          ? item.to === target
          : false;
    });
  }

  it("plans a fresh src project without writing files", () => {
    createTestProject(tmpDir);
    const rootPage = writeTestFile(
      tmpDir,
      "src/app/page.tsx",
      'import Image from "next/image";\nimport styles from "./page.module.css";\nexport default function Home() { return <Image src="/next.svg" alt="Next" />; }\n'
    );
    writeTestFile(tmpDir, "src/app/page.module.css", ".page {}\n");
    const project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);
    const homePage = desiredHomePagePath(project);
    const catchAll = desiredCatchAllPath(project);

    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(operation("mkdir", project.fluxPagesDir)).toBeDefined();
    expect(operation("create", project.configPath)).toBeDefined();
    expect(operation("create", catchAll)).toBeDefined();
    expect(operation("move", homePage)).toMatchObject({
      type: "move",
      from: rootPage,
      to: homePage,
    });
    const move = operation("move", homePage);
    expect(move && "content" in move ? move.content : "").toContain(
      'from "../../app/page.module.css"'
    );
    expect(fs.existsSync(homePage)).toBe(false);
    expect(fs.existsSync(catchAll)).toBe(false);
    expect(fs.readFileSync(rootPage, "utf8")).toContain("next/image");
  });

  it("generates a generic home when no root route exists", () => {
    createTestProject(tmpDir, { layout: "root" });
    const project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);
    const homePage = desiredHomePagePath(project);

    expect(plan.errors).toEqual([]);
    expect(operation("create", homePage)).toMatchObject({ type: "create" });
  });

  it("preserves a custom page and reports route shadowing", () => {
    createTestProject(tmpDir);
    const rootPage = writeTestFile(
      tmpDir,
      "src/app/page.tsx",
      "export default function ProductHome() { return <h1>Product</h1>; }\n"
    );
    const project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);

    expect(plan.warnings.join("\n")).toContain("appears custom");
    expect(operation("skip", rootPage)).toBeDefined();
    expect(operation("create", desiredHomePagePath(project))).toBeUndefined();
    expect(fs.existsSync(rootPage)).toBe(true);
  });

  it("preserves a server-only page", () => {
    createTestProject(tmpDir);
    const rootPage = writeTestFile(
      tmpDir,
      "src/app/page.tsx",
      'import { cookies } from "next/headers";\nexport default function Page() { return cookies().get("session"); }\n'
    );
    const plan = createInitPlan(detectFluxProject(tmpDir));

    expect(plan.warnings.join("\n")).toContain("Server Component APIs");
    expect(operation("skip", rootPage)).toBeDefined();
  });

  it("produces no changed scaffold operations when files already exist", () => {
    createTestProject(tmpDir);
    let project = detectFluxProject(tmpDir);
    writeTestFile(tmpDir, path.relative(tmpDir, project.configPath), "export const fluxConfig = {};\n");
    writeTestFile(
      tmpDir,
      path.relative(tmpDir, desiredHomePagePath(project)),
      '"use client";\nexport default function Home() { return null; }\n'
    );
    writeTestFile(
      tmpDir,
      path.relative(tmpDir, desiredCatchAllPath(project)),
      renderCatchAll(project)
    );
    writeTestFile(
      tmpDir,
      "next.config.ts",
      'import { withFluxFast } from "@fluxfast/next/next-config";\nexport default withFluxFast({});\n'
    );
    project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);

    expect(plan.errors).toEqual([]);
    expect(changedOperations(plan)).toEqual([]);
  });

  it("rejects unsupported Next versions before planning writes", () => {
    createTestProject(tmpDir, {
      dependencies: {
        "@fluxfast/next": "^0.1.0",
        next: "15.4.2",
        react: "19.0.0",
        "react-dom": "19.0.0",
      },
    });
    const plan = createInitPlan(detectFluxProject(tmpDir));

    expect(plan.errors.join("\n")).toContain("Unsupported Next.js version");
    expect(plan.operations).toEqual([]);
  });

  it("rejects Pages Router projects before planning writes", () => {
    createTestProject(tmpDir, { layout: "pages" });
    const plan = createInitPlan(detectFluxProject(tmpDir));

    expect(plan.errors.join("\n")).toContain("requires the Next.js App Router");
    expect(plan.operations).toEqual([]);
  });
});
