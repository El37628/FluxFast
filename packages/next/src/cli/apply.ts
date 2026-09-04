import fs from "node:fs";
import path from "node:path";
import { generatePagesRegistry } from "../generate.js";
import { changedOperations, type InitOperation, type InitPlan } from "./init.js";

export interface ApplyInitOptions {
  logRegistry?: boolean;
}

export interface ApplyInitResult {
  changed: number;
  registryPath: string;
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function nearestExistingAncestor(target: string): string {
  let current = target;
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function assertSafeTarget(root: string, realRoot: string, target: string): void {
  const resolved = path.resolve(target);
  if (!isWithin(root, resolved)) {
    throw new Error(`FluxFast refused to write outside the project root: ${target}`);
  }

  const ancestor = nearestExistingAncestor(resolved);
  const realAncestor = fs.realpathSync(ancestor);
  if (!isWithin(realRoot, realAncestor)) {
    throw new Error(
      `FluxFast refused to follow a path outside the project root: ${target}`
    );
  }
}

function operationTargets(operation: InitOperation): string[] {
  if (operation.type === "move") {
    return [operation.from, operation.to];
  }
  if (operation.type === "skip") {
    return operation.path ? [operation.path] : [];
  }
  return [operation.path];
}

function assertPlanStillApplies(plan: InitPlan): void {
  if (plan.errors.length > 0) {
    throw new Error(plan.errors.join("\n"));
  }

  const root = path.resolve(plan.project.root);
  const realRoot = fs.realpathSync(root);
  for (const operation of plan.operations) {
    for (const target of operationTargets(operation)) {
      assertSafeTarget(root, realRoot, target);
    }

    if (operation.type === "create" && exists(operation.path)) {
      throw new Error(
        `${operation.path} was created after FluxFast analyzed the project.`
      );
    }
    if (operation.type === "modify") {
      if (
        !exists(operation.path) ||
        fs.readFileSync(operation.path, "utf8") !== operation.before
      ) {
        throw new Error(
          `${operation.path} changed after FluxFast analyzed it; run fluxfast init again.`
        );
      }
    }
    if (operation.type === "move") {
      if (
        !exists(operation.from) ||
        fs.readFileSync(operation.from, "utf8") !== operation.before
      ) {
        throw new Error(
          `${operation.from} changed after FluxFast analyzed it; run fluxfast init again.`
        );
      }
      if (exists(operation.to)) {
        throw new Error(
          `${operation.to} was created after FluxFast analyzed the project.`
        );
      }
    }
  }

  assertSafeTarget(root, realRoot, plan.project.fluxPagesDir);
  assertSafeTarget(root, realRoot, plan.project.registryPath);
}

/** Apply a validated plan and roll back task-owned writes if any step fails. */
export function applyInitPlan(
  plan: InitPlan,
  options: ApplyInitOptions = {}
): ApplyInitResult {
  assertPlanStillApplies(plan);
  const rollback: Array<() => void> = [];

  const ensureDirectory = (directory: string): void => {
    if (exists(directory)) return;
    const missing: string[] = [];
    let current = directory;
    while (!exists(current)) {
      missing.push(current);
      current = path.dirname(current);
    }
    for (const target of missing.reverse()) {
      fs.mkdirSync(target);
      rollback.push(() => {
        if (exists(target) && fs.readdirSync(target).length === 0) {
          fs.rmdirSync(target);
        }
      });
    }
  };

  const createFile = (target: string, content: string): void => {
    ensureDirectory(path.dirname(target));
    rollback.push(() => {
      if (exists(target)) fs.unlinkSync(target);
    });
    fs.writeFileSync(target, content, "utf8");
  };

  try {
    for (const operation of plan.operations) {
      if (operation.type === "skip") continue;
      if (operation.type === "mkdir") {
        ensureDirectory(operation.path);
      } else if (operation.type === "create") {
        createFile(operation.path, operation.content);
      } else if (operation.type === "modify") {
        rollback.push(() =>
          fs.writeFileSync(operation.path, operation.before, "utf8")
        );
        fs.writeFileSync(operation.path, operation.after, "utf8");
      } else if (operation.type === "move") {
        ensureDirectory(path.dirname(operation.to));
        rollback.push(() => {
          fs.writeFileSync(operation.from, operation.before, "utf8");
          if (exists(operation.to)) fs.unlinkSync(operation.to);
        });
        fs.writeFileSync(operation.to, operation.content, "utf8");
        if (fs.readFileSync(operation.to, "utf8") !== operation.content) {
          throw new Error(`Could not verify migrated page at ${operation.to}.`);
        }
        fs.unlinkSync(operation.from);
      } else if (operation.type === "remove") {
        const before = fs.readFileSync(operation.path, "utf8");
        rollback.push(() => fs.writeFileSync(operation.path, before, "utf8"));
        fs.unlinkSync(operation.path);
      }
    }

    const registryExisted = exists(plan.project.registryPath);
    const registryBefore = registryExisted
      ? fs.readFileSync(plan.project.registryPath, "utf8")
      : undefined;
    ensureDirectory(plan.project.fluxPagesDir);
    ensureDirectory(path.dirname(plan.project.registryPath));
    rollback.push(() => {
      if (registryExisted && registryBefore !== undefined) {
        fs.writeFileSync(plan.project.registryPath, registryBefore, "utf8");
      } else if (exists(plan.project.registryPath)) {
        fs.unlinkSync(plan.project.registryPath);
      }
    });
    generatePagesRegistry({
      pagesDir: plan.project.fluxPagesDir,
      outputFile: plan.project.registryPath,
      log: options.logRegistry,
    });

    return {
      changed: changedOperations(plan).length,
      registryPath: plan.project.registryPath,
    };
  } catch (error) {
    for (const undo of rollback.reverse()) {
      try {
        undo();
      } catch {
        // Preserve the original failure. Best-effort rollback has no extra files.
      }
    }
    throw error;
  }
}
