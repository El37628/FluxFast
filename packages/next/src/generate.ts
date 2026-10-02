import {
  checkFluxFastProject as checkSharedProject,
  createPagesRegistrySnapshot as createSharedRegistrySnapshot,
  generateFluxFastProject as generateSharedProject,
  generatePagesRegistry as generateSharedRegistry,
} from "@fluxfast/codegen";
import type { FluxPageRegistryTarget, ValidatorCompilationDiagnostic } from "@fluxfast/codegen";

export interface GenerateOptions {
  pagesDir?: string;
  outputFile?: string;
  log?: boolean;
}

export interface PagesRegistrySnapshot {
  content: string;
  files: string[];
  identifiers: string[];
  outputFile: string;
  pagesDir: string;
}

export interface FluxFastGenerationOptions extends GenerateOptions {
  generatedDir?: string;
  /** Manifest content to validate and persist at `schemaFile`. */
  schemaContent?: string;
  schemaFile?: string;
}

export interface FluxFastGenerationResult {
  generatedFiles: string[];
  generatedValidators: readonly string[];
  registryPath: string;
  schemaFile?: string;
  validatorDiagnostics: readonly ValidatorCompilationDiagnostic[];
}

export interface FluxFastGenerationCheckResult {
  checkedFiles: string[];
  current: boolean;
  generatedValidators: readonly string[];
  registryPath: string;
  schemaFile?: string;
  staleFiles: string[];
  validatorDiagnostics: readonly ValidatorCompilationDiagnostic[];
}

const NEXT_REGISTRY_TARGET: FluxPageRegistryTarget = Object.freeze({
  runtimeImport: "@fluxfast/next",
  rootExport: "FluxRoot",
  applicationPropsExport: "FluxApplicationProps",
  clientDirective: true,
});

/** Render the deterministic Next registry without modifying the project. */
export function createPagesRegistrySnapshot(
  options: GenerateOptions = {}
): PagesRegistrySnapshot {
  return createSharedRegistrySnapshot({
    pagesDir: options.pagesDir,
    outputFile: options.outputFile,
    target: NEXT_REGISTRY_TARGET,
  });
}

export function generatePagesRegistry(options: GenerateOptions = {}): void {
  generateSharedRegistry(createPagesRegistrySnapshot(options), { log: options.log });
}

/** Generate through framework-neutral Codegen with the existing Next registry. */
export function generateFluxFastProject(
  options: FluxFastGenerationOptions = {}
): FluxFastGenerationResult {
  return generateSharedProject({ ...options, registry: createPagesRegistrySnapshot(options) });
}

/** Check through Codegen without creating or modifying files. */
export function checkFluxFastProject(
  options: FluxFastGenerationOptions = {}
): FluxFastGenerationCheckResult {
  return checkSharedProject({ ...options, registry: createPagesRegistrySnapshot(options) });
}
