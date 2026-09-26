import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  desiredAgentInstructionPaths,
  desiredAgentKnowledgePath,
  FLUXFAST_AGENT_BLOCK_START,
  FLUXFAST_AGENT_KNOWLEDGE_MARKER,
  renderAgentInstructionBlock,
  renderAgentKnowledge,
} from "../../src/cli/agent-knowledge";
import {
  desiredCatchAllPath,
  desiredHealthRoutePath,
  desiredHomePagePath,
  desiredTransportRoutePath,
  renderCatchAll,
  renderHealthRoute,
  renderTransportRoute,
} from "../../src/cli/files";
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
    const healthRoute = desiredHealthRoutePath(project);
    const transportRoute = desiredTransportRoutePath(project);
    const knowledgePath = desiredAgentKnowledgePath(project);
    const [agentsPath, claudePath] = desiredAgentInstructionPaths(project);

    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(operation("mkdir", project.fluxPagesDir)).toBeDefined();
    expect(operation("create", project.configPath)).toBeDefined();
    expect(operation("create", catchAll)).toBeDefined();
    expect(operation("create", healthRoute)).toMatchObject({
      type: "create",
      content: renderHealthRoute(),
    });
    expect(operation("create", transportRoute)).toMatchObject({
      type: "create",
      content: renderTransportRoute(),
    });
    expect(operation("create", knowledgePath)).toMatchObject({
      type: "create",
      content: renderAgentKnowledge(project),
    });
    expect(operation("create", agentsPath)).toMatchObject({ type: "create" });
    expect(operation("create", claudePath)).toMatchObject({ type: "create" });
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
    expect(fs.existsSync(healthRoute)).toBe(false);
    expect(fs.existsSync(transportRoute)).toBe(false);
    expect(fs.existsSync(knowledgePath)).toBe(false);
    expect(fs.existsSync(agentsPath)).toBe(false);
    expect(fs.existsSync(claudePath)).toBe(false);
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
      path.relative(tmpDir, desiredHealthRoutePath(project)),
      renderHealthRoute()
    );
    writeTestFile(
      tmpDir,
      path.relative(tmpDir, desiredTransportRoutePath(project)),
      renderTransportRoute()
    );
    writeTestFile(
      tmpDir,
      "next.config.ts",
      'import { withFluxFast } from "@fluxfast/next/next-config";\nexport default withFluxFast({});\n'
    );
    writeTestFile(
      tmpDir,
      path.relative(tmpDir, desiredAgentKnowledgePath(project)),
      renderAgentKnowledge(project)
    );
    for (const instructionPath of desiredAgentInstructionPaths(project)) {
      writeTestFile(
        tmpDir,
        path.relative(tmpDir, instructionPath),
        `${renderAgentInstructionBlock(project)}\n`
      );
    }
    project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);

    expect(plan.errors).toEqual([]);
    expect(changedOperations(plan)).toEqual([]);
  });

  it("preserves existing agent instructions and appends one managed block", () => {
    createTestProject(tmpDir);
    const existing = "# Project rules\n\nKeep user instructions.\n";
    const agentsPath = writeTestFile(tmpDir, "AGENTS.md", existing);
    const project = detectFluxProject(tmpDir);
    const plan = createInitPlan(project);
    const update = plan.operations.find(
      item => item.type === "modify" && item.path === agentsPath
    );
    const after = update && "after" in update ? update.after : "";

    expect(update).toMatchObject({ type: "modify", before: existing });
    expect(after).toContain(existing);
    expect(after).toContain(FLUXFAST_AGENT_BLOCK_START);
    expect(after.match(/fluxfast-agent-knowledge:start/g)).toHaveLength(1);
  });

  it("updates generated knowledge but preserves a custom collision without force", () => {
    createTestProject(tmpDir);
    let project = detectFluxProject(tmpDir);
    const knowledgePath = desiredAgentKnowledgePath(project);
    writeTestFile(
      tmpDir,
      path.relative(tmpDir, knowledgePath),
      `${FLUXFAST_AGENT_KNOWLEDGE_MARKER}\nold generated content\n`
    );

    let plan = createInitPlan(detectFluxProject(tmpDir));
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ type: "modify", path: knowledgePath })
    );

    fs.writeFileSync(knowledgePath, "# Custom project knowledge\n", "utf8");
    project = detectFluxProject(tmpDir);
    plan = createInitPlan(project);
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ type: "skip", path: knowledgePath })
    );
    expect(plan.manualActions.join("\n")).toContain("init --force");

    const forced = createInitPlan(project, { force: true });
    expect(forced.operations).toContainEqual({
      type: "modify",
      path: knowledgePath,
      before: "# Custom project knowledge\n",
      after: renderAgentKnowledge(project),
    });
  });

  it("does not rewrite an incomplete managed instruction block", () => {
    createTestProject(tmpDir);
    const agentsPath = writeTestFile(
      tmpDir,
      "AGENTS.md",
      `# Project rules\n\n${FLUXFAST_AGENT_BLOCK_START}\n`
    );
    const plan = createInitPlan(detectFluxProject(tmpDir));

    expect(plan.operations).toContainEqual(
      expect.objectContaining({ type: "skip", path: agentsPath })
    );
    expect(plan.manualActions.join("\n")).toContain("Repair or remove");
    expect(fs.readFileSync(agentsPath, "utf8")).toContain("# Project rules");
  });

  it("preserves a custom reserved health route unless force repairs it", () => {
    createTestProject(tmpDir);
    const project = detectFluxProject(tmpDir);
    const healthRoutePath = desiredHealthRoutePath(project);
    const custom = "export function GET() { return new Response('custom'); }\n";
    writeTestFile(tmpDir, path.relative(tmpDir, healthRoutePath), custom);

    const safePlan = createInitPlan(detectFluxProject(tmpDir));
    expect(safePlan.manualActions.join("\n")).toContain("init --force");
    expect(safePlan.operations).toContainEqual(
      expect.objectContaining({ type: "skip", path: healthRoutePath })
    );

    const forcedPlan = createInitPlan(detectFluxProject(tmpDir), { force: true });
    expect(forcedPlan.operations).toContainEqual({
      type: "modify",
      path: healthRoutePath,
      before: custom,
      after: renderHealthRoute(),
    });
  });

  it("preserves an invalid catch-all unless force explicitly repairs it", () => {
    createTestProject(tmpDir);
    const project = detectFluxProject(tmpDir);
    const catchAllPath = desiredCatchAllPath(project);
    const invalidContent = "export default function CustomRoute() { return null; }\n";
    writeTestFile(
      tmpDir,
      path.relative(tmpDir, catchAllPath),
      invalidContent
    );

    const safePlan = createInitPlan(detectFluxProject(tmpDir));
    expect(safePlan.manualActions.join("\n")).toContain("init --force");
    expect(safePlan.operations).toContainEqual(
      expect.objectContaining({ type: "skip", path: catchAllPath })
    );

    const forcedPlan = createInitPlan(detectFluxProject(tmpDir), { force: true });
    expect(forcedPlan.manualActions).toEqual([]);
    expect(forcedPlan.warnings.join("\n")).toContain("--force was used");
    expect(forcedPlan.operations).toContainEqual({
      type: "modify",
      path: catchAllPath,
      before: invalidContent,
      after: renderCatchAll(project),
    });
    expect(fs.readFileSync(catchAllPath, "utf8")).toBe(invalidContent);
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
