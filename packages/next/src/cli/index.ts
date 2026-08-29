import { generatePagesRegistry } from "../generate";
import { applyInitPlan } from "./apply";
import {
  validateFluxProject,
  type DiagnosticSection,
  type FluxDiagnostic,
  type FluxValidationReport,
} from "./diagnostics";
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
  fluxfast init [--dry-run] [--yes] [--force]
  fluxfast init --check
  fluxfast generate
  fluxfast doctor
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

function diagnosticLine(item: FluxDiagnostic): string {
  const symbol = item.status === "pass" ? "✓" : item.status === "warning" ? "!" : "✗";
  return `${symbol} ${item.message}`;
}

function uniqueFixes(report: FluxValidationReport): string[] {
  return [
    ...new Set(
      report.diagnostics
        .filter(item => item.status === "fail" || item.blocksCheck)
        .map(item => item.fix)
        .filter((fix): fix is string => Boolean(fix))
    ),
  ];
}

function renderFixes(report: FluxValidationReport, io: CliIo): void {
  const fixes = uniqueFixes(report);
  if (fixes.length === 0) return;
  io.stdout("\nFix:\n");
  for (const fix of fixes) {
    io.stdout(`  ${fix}`);
  }
}

function runCheck(io: CliIo): number {
  const project = detectFluxProject(io.cwd);
  const report = validateFluxProject(project);
  io.stdout("FluxFast Configuration Check\n");
  for (const item of report.diagnostics) {
    io.stdout(diagnosticLine(item));
  }
  if (report.valid) {
    io.stdout("\nFluxFast is configured correctly.");
    return 0;
  }
  renderFixes(report, io);
  io.stdout("\nFluxFast configuration is incomplete.");
  return 1;
}

function runInit(args: string[], io: CliIo): number {
  const supportedOptions = new Set(["--dry-run", "--yes", "--check", "--force"]);
  const unknown = args.find(argument => !supportedOptions.has(argument));
  if (unknown) {
    io.stderr(`Unknown option: ${unknown}\n\n${USAGE}`);
    return 2;
  }
  if (args.includes("--check")) {
    if (args.length !== 1) {
      io.stderr(`--check cannot be combined with other init options.\n\n${USAGE}`);
      return 2;
    }
    return runCheck(io);
  }

  const project = detectFluxProject(io.cwd);
  const plan = createInitPlan(project, { force: args.includes("--force") });
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

const DOCTOR_SECTIONS: DiagnosticSection[] = [
  "Environment",
  "Packages",
  "Project",
  "Configuration",
  "Pages",
  "Registry",
];

function runDoctor(args: string[], io: CliIo): number {
  if (args.length > 0) {
    io.stderr(`Unknown option: ${args[0]}\n\n${USAGE}`);
    return 2;
  }
  const project = detectFluxProject(io.cwd);
  const report = validateFluxProject(project);
  io.stdout("FluxFast Doctor");
  for (const section of DOCTOR_SECTIONS) {
    const items = report.diagnostics.filter(item => item.section === section);
    if (items.length === 0) continue;
    io.stdout(`\n${section}`);
    for (const item of items) {
      io.stdout(`  ${diagnosticLine(item)}`);
    }
    if (section === "Pages") {
      for (const page of report.pages) {
        io.stdout(`    ✓ ${page}`);
      }
    }
  }
  renderFixes(report, io);
  const hasWarnings = report.diagnostics.some(item => item.status === "warning");
  if (report.valid && !hasWarnings) {
    io.stdout("\nNo problems found.");
  } else if (report.valid) {
    io.stdout("\nNo blocking problems found.");
  } else {
    io.stdout("\nFluxFast found configuration problems.");
  }
  return report.valid ? 0 : 1;
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
    if (command === "doctor") {
      return runDoctor(commandArgs, io);
    }
    io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`✗ ${message}`);
    return 1;
  }
}
