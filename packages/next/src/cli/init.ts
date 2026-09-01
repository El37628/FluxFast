import fs from "node:fs";
import path from "node:path";
import { validateInitPrerequisites } from "./diagnostics";
import {
  desiredCatchAllPath,
  desiredHealthRoutePath,
  desiredHomePagePath,
  isFluxCatchAll,
  isFluxHealthRoute,
  renderCatchAll,
  renderFluxConfig,
  renderHealthRoute,
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

export interface InitPlanOptions {
  force?: boolean;
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

/** Create a deterministic, read-only plan for FluxFast-owned scaffolding. */
export function createInitPlan(
  project: FluxProjectInfo,
  options: InitPlanOptions = {}
): InitPlan {
  const operations: InitOperation[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const manualActions: string[] = [];
  errors.push(
    ...validateInitPrerequisites(project)
      .filter(item => item.status === "fail" || item.blocksCheck)
      .map(item => item.message)
  );

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
    const before = fs.readFileSync(catchAllPath, "utf8");
    const after = renderCatchAll(project);
    if (before === after || (isFluxCatchAll(before) && !options.force)) {
      operations.push({
        type: "skip",
        path: catchAllPath,
        reason: "FluxFast catch-all already exists",
      });
    } else if (options.force) {
      operations.push({
        type: "modify",
        path: catchAllPath,
        before,
        after,
      });
      warnings.push(
        `${relativeProjectPath(project, catchAllPath)} was replaced because --force was used.`
      );
    } else {
      const displayPath = relativeProjectPath(project, catchAllPath);
      const warning = `${displayPath} exists but is not a valid FluxFast catch-all.`;
      warnings.push(warning);
      manualActions.push(
        `Repair ${displayPath} manually or run npx fluxfast init --force.`
      );
      operations.push({ type: "skip", path: catchAllPath, reason: warning });
    }
  } else {
    operations.push({
      type: "create",
      path: catchAllPath,
      content: renderCatchAll(project),
    });
  }

  const healthRoutePath = desiredHealthRoutePath(project);
  if (isFile(healthRoutePath)) {
    const before = fs.readFileSync(healthRoutePath, "utf8");
    const after = renderHealthRoute();
    if (before === after || (isFluxHealthRoute(before) && !options.force)) {
      operations.push({
        type: "skip",
        path: healthRoutePath,
        reason: "FluxFast public health route already exists",
      });
    } else if (options.force) {
      operations.push({
        type: "modify",
        path: healthRoutePath,
        before,
        after,
      });
      warnings.push(
        `${relativeProjectPath(project, healthRoutePath)} was replaced because --force was used.`
      );
    } else {
      const displayPath = relativeProjectPath(project, healthRoutePath);
      const warning = `${displayPath} occupies FluxFast's reserved public health route.`;
      warnings.push(warning);
      manualActions.push(
        `Repair ${displayPath} manually or run npx fluxfast init --force.`
      );
      operations.push({ type: "skip", path: healthRoutePath, reason: warning });
    }
  } else {
    operations.push({
      type: "create",
      path: healthRoutePath,
      content: renderHealthRoute(),
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
