import fs from "node:fs";
import path from "node:path";
import {
  desiredCatchAllPath,
  desiredHomePagePath,
  renderCatchAll,
  renderFluxConfig,
  renderStarterPage,
} from "./files";
import { inspectPage, prepareMigratedPage } from "./migration";
import { planNextConfigIntegration } from "./next-config";
import type { FluxProjectInfo } from "./types";

export type InitOperation =
  | { type: "mkdir"; path: string }
  | { type: "create"; path: string; content: string }
  | { type: "modify"; path: string; before: string; after: string }
  | { type: "move"; from: string; to: string; before: string; content: string }
  | { type: "remove"; path: string }
  | { type: "skip"; path?: string; reason: string };

export interface InitPlan {
  project: FluxProjectInfo;
  operations: InitOperation[];
  warnings: string[];
  errors: string[];
  manualActions: string[];
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath: string): boolean {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function addProjectErrors(project: FluxProjectInfo, errors: string[]): void {
  if (!project.hasAppRouter) {
    errors.push(
      project.pagesRouterDir
        ? `FluxFast requires the Next.js App Router; detected Pages Router at ${project.pagesRouterDir}.`
        : "FluxFast requires a Next.js App Router directory (app/ or src/app/)."
    );
  }
  if (project.packages.next.compatibility === "unsupported") {
    errors.push(
      `Unsupported Next.js version: ${project.packages.next.effectiveVersion}. FluxFast supports >=16.3.0 <17.0.0.`
    );
  }
  if (!project.packages.next.effectiveVersion) {
    errors.push("Next.js is not listed or installed in this project.");
  }
  if (!project.packages.fluxfastNext.effectiveVersion) {
    errors.push(
      "@fluxfast/next is not installed. Install it before running fluxfast init."
    );
  }
  for (const dependency of [project.packages.react, project.packages.reactDom]) {
    if (dependency.compatibility === "unsupported") {
      errors.push(
        `Unsupported ${dependency.name} version: ${dependency.effectiveVersion}. FluxFast requires React 19 or newer.`
      );
    }
  }
  if (project.nextConfigPaths.length > 1) {
    errors.push("Multiple next.config files were detected; keep only the active one.");
  }
  if (project.configPaths.length > 1) {
    errors.push("Multiple fluxfast.config files were detected; keep only the active one.");
  }
}

/** Create a deterministic, read-only plan for FluxFast-owned scaffolding. */
export function createInitPlan(project: FluxProjectInfo): InitPlan {
  const operations: InitOperation[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const manualActions: string[] = [];
  addProjectErrors(project, errors);

  if (errors.length > 0) {
    return { project, operations, warnings, errors, manualActions };
  }

  if (!isDirectory(project.fluxPagesDir)) {
    operations.push({ type: "mkdir", path: project.fluxPagesDir });
  }

  if (isFile(project.configPath)) {
    operations.push({
      type: "skip",
      path: project.configPath,
      reason: "FluxFast config already exists",
    });
  } else {
    operations.push({
      type: "create",
      path: project.configPath,
      content: renderFluxConfig(project),
    });
  }

  const catchAllPath = desiredCatchAllPath(project);
  if (isFile(catchAllPath)) {
    operations.push({
      type: "skip",
      path: catchAllPath,
      reason: "FluxFast catch-all already exists",
    });
  } else {
    operations.push({
      type: "create",
      path: catchAllPath,
      content: renderCatchAll(project),
    });
  }

  const homePagePath = desiredHomePagePath(project);
  if (project.rootPagePath) {
    if (isFile(homePagePath)) {
      const warning = `${project.rootPagePath} remains in place because ${homePagePath} already exists.`;
      warnings.push(warning);
      manualActions.push(
        `Remove or migrate ${project.rootPagePath}; it shadows the FluxFast route "/".`
      );
      operations.push({ type: "skip", path: project.rootPagePath, reason: warning });
    } else {
      const original = fs.readFileSync(project.rootPagePath, "utf8");
      const inspection = inspectPage(original);
      if (inspection.safety === "default-page") {
        operations.push({
          type: "move",
          from: project.rootPagePath,
          to: homePagePath,
          before: original,
          content: prepareMigratedPage(
            original,
            project.rootPagePath,
            homePagePath
          ),
        });
      } else {
        const warning =
          inspection.safety === "server-only"
            ? `${project.rootPagePath} uses Server Component APIs and was not selected for migration.`
            : `${project.rootPagePath} appears custom and was not selected for migration.`;
        warnings.push(warning);
        manualActions.push(
          `Create or migrate the FluxFast home page at ${homePagePath}, then remove ${project.rootPagePath}.`
        );
        operations.push({
          type: "skip",
          path: project.rootPagePath,
          reason: `${warning} ${inspection.reasons.join(", ")}`,
        });
      }
    }
  } else if (isFile(homePagePath)) {
    operations.push({
      type: "skip",
      path: homePagePath,
      reason: "FluxFast home page already exists",
    });
  } else {
    operations.push({
      type: "create",
      path: homePagePath,
      content: renderStarterPage(),
    });
  }

  const nextConfig = planNextConfigIntegration(project);
  if (nextConfig.operation) {
    operations.push(nextConfig.operation);
  }
  if (nextConfig.manualAction) {
    manualActions.push(nextConfig.manualAction);
  }

  return { project, operations, warnings, errors, manualActions };
}

export function changedOperations(plan: InitPlan): InitOperation[] {
  return plan.operations.filter(operation => operation.type !== "skip");
}

export function relativeProjectPath(project: FluxProjectInfo, target: string): string {
  return path.relative(project.root, target) || ".";
}
