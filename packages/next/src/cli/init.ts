import fs from "node:fs";
import path from "node:path";
import {
  desiredAgentInstructionPaths,
  desiredAgentKnowledgePath,
  isFluxFastAgentKnowledge,
  mergeAgentInstructionBlock,
  renderAgentInstructionBlock,
  renderAgentKnowledge,
} from "./agent-knowledge.js";
import { validateInitPrerequisites } from "./diagnostics.js";
import {
  desiredCatchAllPath,
  desiredHealthRoutePath,
  desiredHomePagePath,
  desiredTransportRoutePath,
  isFluxCatchAll,
  isFluxHealthRoute,
  isFluxTransportRoute,
  renderCatchAll,
  renderFluxConfig,
  renderHealthRoute,
  renderStarterPage,
  renderTransportRoute,
} from "./files.js";
import { inspectPage, prepareMigratedPage } from "./migration.js";
import { planNextConfigIntegration } from "./next-config.js";
import type { FluxProjectInfo } from "./types.js";

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

function planAgentKnowledge(
  project: FluxProjectInfo,
  options: InitPlanOptions,
  operations: InitOperation[],
  warnings: string[],
  manualActions: string[]
): void {
  const knowledgePath = desiredAgentKnowledgePath(project);
  const knowledgeContent = renderAgentKnowledge(project);
  const knowledgeDisplayPath = relativeProjectPath(project, knowledgePath);

  if (isDirectory(knowledgePath)) {
    const warning = `${knowledgeDisplayPath} is a directory, so FluxFast could not install agent knowledge there.`;
    warnings.push(warning);
    manualActions.push(
      `Move or remove ${knowledgeDisplayPath}, then run npx fluxfast init again.`
    );
    operations.push({ type: "skip", path: knowledgePath, reason: warning });
  } else if (isFile(knowledgePath)) {
    const before = fs.readFileSync(knowledgePath, "utf8");
    if (before === knowledgeContent) {
      operations.push({
        type: "skip",
        path: knowledgePath,
        reason: "FluxFast agent knowledge is current",
      });
    } else if (isFluxFastAgentKnowledge(before) || options.force) {
      operations.push({
        type: "modify",
        path: knowledgePath,
        before,
        after: knowledgeContent,
      });
      if (!isFluxFastAgentKnowledge(before)) {
        warnings.push(
          `${knowledgeDisplayPath} was replaced because --force was used.`
        );
      }
    } else {
      const warning =
        `${knowledgeDisplayPath} exists but is not managed by FluxFast.`;
      warnings.push(warning);
      manualActions.push(
        `Move ${knowledgeDisplayPath} or run npx fluxfast init --force to replace it.`
      );
      operations.push({ type: "skip", path: knowledgePath, reason: warning });
    }
  } else {
    operations.push({
      type: "create",
      path: knowledgePath,
      content: knowledgeContent,
    });
  }

  const instructionBlock = renderAgentInstructionBlock(project);
  for (const instructionPath of desiredAgentInstructionPaths(project)) {
    const instructionDisplayPath = relativeProjectPath(
      project,
      instructionPath
    );
    if (isDirectory(instructionPath)) {
      const warning = `${instructionDisplayPath} is a directory, so FluxFast could not add its agent knowledge reference.`;
      warnings.push(warning);
      manualActions.push(
        `Move or remove ${instructionDisplayPath}, then run npx fluxfast init again.`
      );
      operations.push({ type: "skip", path: instructionPath, reason: warning });
      continue;
    }

    if (!isFile(instructionPath)) {
      operations.push({
        type: "create",
        path: instructionPath,
        content: `${instructionBlock}\n`,
      });
      continue;
    }

    const before = fs.readFileSync(instructionPath, "utf8");
    const merge = mergeAgentInstructionBlock(before, instructionBlock);
    if (merge.status === "malformed") {
      const warning = `${instructionDisplayPath} has an incomplete FluxFast agent knowledge marker block.`;
      warnings.push(warning);
      manualActions.push(
        `Repair or remove the FluxFast marker block in ${instructionDisplayPath}, then run npx fluxfast init again.`
      );
      operations.push({ type: "skip", path: instructionPath, reason: warning });
    } else if (merge.status === "unchanged") {
      operations.push({
        type: "skip",
        path: instructionPath,
        reason: "FluxFast agent knowledge reference is current",
      });
    } else {
      operations.push({
        type: "modify",
        path: instructionPath,
        before,
        after: merge.content,
      });
    }
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

  const transportRoutePath = desiredTransportRoutePath(project);
  if (isFile(transportRoutePath)) {
    const before = fs.readFileSync(transportRoutePath, "utf8");
    const after = renderTransportRoute();
    if (before === after || (isFluxTransportRoute(before) && !options.force)) {
      operations.push({
        type: "skip",
        path: transportRoutePath,
        reason: "FluxFast production transport route already exists",
      });
    } else if (options.force) {
      operations.push({
        type: "modify",
        path: transportRoutePath,
        before,
        after,
      });
      warnings.push(
        `${relativeProjectPath(project, transportRoutePath)} was replaced because --force was used.`
      );
    } else {
      const displayPath = relativeProjectPath(project, transportRoutePath);
      const warning = `${displayPath} occupies FluxFast's reserved production transport route.`;
      warnings.push(warning);
      manualActions.push(
        `Repair ${displayPath} manually or run npx fluxfast init --force.`
      );
      operations.push({ type: "skip", path: transportRoutePath, reason: warning });
    }
  } else {
    operations.push({
      type: "create",
      path: transportRoutePath,
      content: renderTransportRoute(),
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

  planAgentKnowledge(project, options, operations, warnings, manualActions);

  return { project, operations, warnings, errors, manualActions };
}

export function changedOperations(plan: InitPlan): InitOperation[] {
  return plan.operations.filter(operation => operation.type !== "skip");
}

export function relativeProjectPath(project: FluxProjectInfo, target: string): string {
  return path.relative(project.root, target) || ".";
}
