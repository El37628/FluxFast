import { generatePagesRegistry } from "../generate";
import { applyInitPlan } from "./apply";
import {
  changedOperations,
  createInitPlan,
  relativeProjectPath,
  type InitOperation,
  type InitPlan,
} from "./init";
import { detectFluxProject } from "./project";

export interface CliIo {
  cwd: string;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  cwd: process.cwd(),
  stdout: message => console.log(message),
  stderr: message => console.error(message),
};

const USAGE = `Usage:
  fluxfast init [--dry-run] [--yes]
  fluxfast generate
  fluxfast --help`;

function displayPath(plan: InitPlan, target: string): string {
  return relativeProjectPath(plan.project, target).replace(/\\/g, "/");
}

function writePlanWarnings(plan: InitPlan, io: CliIo): void {
  for (const warning of plan.warnings) {
    io.stdout(`! ${warning}`);
  }
  if (plan.manualActions.length > 0) {
    io.stdout("\nManual action required:\n");
    for (const action of plan.manualActions) {
      io.stdout(`  ${action}`);
    }
  }
}

function groupOperations(
  operations: InitOperation[]
): Map<InitOperation["type"], InitOperation[]> {
  const grouped = new Map<InitOperation["type"], InitOperation[]>();
  for (const operation of operations) {
    const existing = grouped.get(operation.type) ?? [];
    existing.push(operation);
    grouped.set(operation.type, existing);
  }
  return grouped;
}

function renderDryRun(plan: InitPlan, io: CliIo): void {
  io.stdout("FluxFast Setup — Dry Run\n");
  const grouped = groupOperations(changedOperations(plan));
  const labels: ReadonlyArray<readonly [InitOperation["type"], string]> = [
    ["mkdir", "Would create directory:"],
    ["create", "Would create:"],
    ["modify", "Would modify:"],
    ["move", "Would move:"],
    ["remove", "Would remove:"],
  ];
  for (const [type, label] of labels) {
    const operations = grouped.get(type);
    if (!operations?.length) continue;
    io.stdout(label);
    for (const operation of operations) {
      if (operation.type === "move") {
        io.stdout(
          `  ${displayPath(plan, operation.from)}\n  → ${displayPath(plan, operation.to)}`
        );
      } else if (operation.type !== "skip") {
        io.stdout(`  ${displayPath(plan, operation.path)}`);
      }
    }
    io.stdout("");
  }
  writePlanWarnings(plan, io);
  io.stdout("\nNo files were changed.");
}

function renderAppliedPlan(plan: InitPlan, io: CliIo): void {
  for (const operation of changedOperations(plan)) {
    if (operation.type === "mkdir") {
      io.stdout(`✓ Created ${displayPath(plan, operation.path)}/`);
    } else if (operation.type === "create") {
      io.stdout(`✓ Created ${displayPath(plan, operation.path)}`);
    } else if (operation.type === "modify") {
      io.stdout(`✓ Updated ${displayPath(plan, operation.path)}`);
    } else if (operation.type === "move") {
      io.stdout(
        `✓ Moved ${displayPath(plan, operation.from)} → ${displayPath(plan, operation.to)}`
      );
    } else if (operation.type === "remove") {
      io.stdout(`✓ Removed ${displayPath(plan, operation.path)}`);
    }
  }
}

function runInit(args: string[], io: CliIo): number {
  const supportedOptions = new Set(["--dry-run", "--yes"]);
  const unknown = args.find(argument => !supportedOptions.has(argument));
  if (unknown) {
    io.stderr(`Unknown option: ${unknown}\n\n${USAGE}`);
    return 2;
  }

  const project = detectFluxProject(io.cwd);
  const plan = createInitPlan(project);
  if (plan.errors.length > 0) {
    io.stderr("FluxFast Setup\n");
    for (const error of plan.errors) {
      io.stderr(`✗ ${error}`);
    }
    return 1;
  }

  if (args.includes("--dry-run")) {
    renderDryRun(plan, io);
    return plan.manualActions.length > 0 ? 1 : 0;
  }

  io.stdout("FluxFast Setup\n");
  const result = applyInitPlan(plan, { logRegistry: false });
  if (result.changed === 0) {
    io.stdout("✓ No scaffold changes required.");
  } else {
    renderAppliedPlan(plan, io);
  }
  io.stdout(`✓ Generated FluxFast registry at ${displayPath(plan, result.registryPath)}`);
  writePlanWarnings(plan, io);
  if (plan.manualActions.length > 0) {
    return 1;
  }
  io.stdout("\nReady.");
  return 0;
}

function runGenerate(args: string[], io: CliIo): number {
  if (args.length > 0) {
    io.stderr(`Unknown option: ${args[0]}\n\n${USAGE}`);
    return 2;
  }
  const project = detectFluxProject(io.cwd);
  generatePagesRegistry({
    pagesDir: project.fluxPagesDir,
    outputFile: project.registryPath,
    log: false,
  });
  io.stdout(
    `✓ Generated FluxFast registry at ${relativeProjectPath(project, project.registryPath).replace(/\\/g, "/")}`
  );
  return 0;
}

export function runCli(args: string[], io: CliIo = defaultIo): number {
  const [command, ...commandArgs] = args;
  try {
    if (!command || command === "--help" || command === "-h") {
      io.stdout(USAGE);
      return 0;
    }
    if (command === "init") {
      return runInit(commandArgs, io);
    }
    if (command === "generate") {
      return runGenerate(commandArgs, io);
    }
    io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`✗ ${message}`);
    return 1;
  }
}
