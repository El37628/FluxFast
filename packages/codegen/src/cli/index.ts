import fs from "node:fs";
import path from "node:path";
import { checkFluxFastProject, generateFluxFastProject } from "../generate.js";
import { createPagesRegistrySnapshot } from "../pages-registry.js";
import type { ValidatorCompilationDiagnostic } from "../validator-compiler.js";
import { findCodegenProjectRoot } from "./project.js";
import { codegenAdapterNames, getCodegenTarget } from "./targets.js";

export interface CodegenCliIo {
  cwd: string;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

interface GenerateArgs {
  adapter: string;
  check: boolean;
  schemaFile?: string;
}

const USAGE = `Usage:
  fluxfast-codegen generate [--adapter next|react] [--check] [--schema-file PATH]
  fluxfast-codegen --help

Supported adapters: ${codegenAdapterNames().join(", ")} (default: next)
Exit codes: 0 = generated/current; 1 = stale files or generation error; 2 = usage error.`;

function usageError(message: string, io: CodegenCliIo): undefined {
  io.stderr(`${message}\n\n${USAGE}`);
  return undefined;
}

function parseGenerateArgs(args: string[], io: CodegenCliIo): GenerateArgs | undefined {
  const parsed: GenerateArgs = { adapter: "next", check: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--check" && flag !== "--schema-file" && flag !== "--adapter") {
      return usageError(`Unknown option: ${flag}`, io);
    }
    if (seen.has(flag)) return usageError(`${flag} may only be provided once.`, io);
    seen.add(flag);
    if (flag === "--check") {
      parsed.check = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      return usageError(`${flag} requires ${flag === "--schema-file" ? "a path" : "an adapter name"}.`, io);
    }
    if (flag === "--adapter") parsed.adapter = value;
    else parsed.schemaFile = path.resolve(io.cwd, value);
  }
  return parsed;
}

function renderValidatorDiagnostics(diagnostics: readonly ValidatorCompilationDiagnostic[], io: CodegenCliIo): void {
  for (const item of diagnostics) {
    io.stdout(`! ${item.contract} cannot receive a client validator.`);
    io.stdout(`  ${item.message}`);
  }
  if (diagnostics.length) {
    io.stdout("  TypeScript generation remains available.");
    io.stdout("  Server validation remains authoritative.");
  }
}

function runGenerate(args: string[], io: CodegenCliIo): number {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.stdout(USAGE);
    return 0;
  }
  const parsed = parseGenerateArgs(args, io);
  if (!parsed) return 2;
  const target = getCodegenTarget(parsed.adapter);
  if (!target) {
    usageError(`Unsupported adapter: ${JSON.stringify(parsed.adapter)}. Supported adapters: ${codegenAdapterNames().join(", ")}.`, io);
    return 2;
  }
  const root = findCodegenProjectRoot(io.cwd);
  const project = target.projectPaths(root);
  const schemaContent = parsed.schemaFile === undefined ? undefined : fs.readFileSync(parsed.schemaFile, "utf8");
  const registry = createPagesRegistrySnapshot({
    pagesDir: project.pagesDir,
    outputFile: project.registryPath,
    target: target.registry,
  });
  const options = { registry, generatedDir: project.generatedDir, schemaContent, log: false };
  const relative = (file: string): string => path.relative(root, file).replace(/\\/g, "/");
  if (parsed.check) {
    const result = checkFluxFastProject(options);
    renderValidatorDiagnostics(result.validatorDiagnostics, io);
    if (result.current) {
      io.stdout("✓ Generated FluxFast files are current.");
      return 0;
    }
    io.stdout(parsed.schemaFile === undefined
      ? `✗ Generated FluxFast types are out of date.\n\nRun:\n\n  npx fluxfast-codegen generate --adapter ${parsed.adapter}`
      : "✗ Generated FluxFast types are out of date.\n\nRerun the full-stack type generation command without --check.");
    return 1;
  }
  const result = generateFluxFastProject(options);
  renderValidatorDiagnostics(result.validatorDiagnostics, io);
  if (parsed.schemaFile !== undefined && result.schemaFile) {
    io.stdout(`✓ Generated FluxFast schema at ${relative(result.schemaFile)}`);
  }
  io.stdout(`✓ Generated FluxFast registry at ${relative(result.registryPath)}`);
  if (result.schemaFile) {
    io.stdout(`✓ Generated FluxFast types from ${relative(result.schemaFile)}`);
    for (const file of result.generatedFiles.filter(file => file !== result.registryPath)) {
      io.stdout(`  ${relative(file)}`);
    }
  }
  return 0;
}

/** Private binary implementation; not a package-root JavaScript API. */
export function runCodegenCli(args: string[], io: CodegenCliIo = {
  cwd: process.cwd(),
  stdout: message => console.log(message),
  stderr: message => console.error(message),
}): number {
  const [command, ...commandArgs] = args;
  try {
    if (!command || command === "--help" || command === "-h") {
      io.stdout(USAGE);
      return 0;
    }
    if (command !== "generate") {
      usageError(`Unknown command: ${command}`, io);
      return 2;
    }
    return runGenerate(commandArgs, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`✗ ${message}`);
    return 1;
  }
}
