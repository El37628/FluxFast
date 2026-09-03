import fs from "node:fs";
import path from "node:path";
import { compileFluxFastMutations } from "./mutation-compiler";
import { compileFluxFastPageRoutes } from "./route-compiler";
import { compileFluxFastResourceTypes } from "./schema-compiler";
import { parseFluxFastSchemaManifest } from "./schema-manifest";
import { compileFluxFastValidatorsWithDiagnostics } from "./validator-compiler";
import type { ValidatorCompilationDiagnostic } from "./validator-compiler";

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

interface FluxFastGeneratedArtifact {
  content: string;
  path: string;
}

interface FluxFastProjectSnapshot {
  artifacts: FluxFastGeneratedArtifact[];
  generatedValidators: readonly string[];
  generatedDir: string;
  pagesDir: string;
  registryPath: string;
  schemaContent?: string;
  schemaFile?: string;
  validatorDiagnostics: readonly ValidatorCompilationDiagnostic[];
}

const PAGE_EXTENSION = /\.(tsx|jsx)$/;
const IGNORED_PAGE = /\.(test|spec|stories)\.(tsx|jsx)$/;
const SAFE_PAGE_FILE =
  /^[A-Za-z0-9_.@()\[\]-]+(?:\/[A-Za-z0-9_.@()\[\]-]+)*\.(?:tsx|jsx)$/;

function assertGeneratedOutputPath(
  generatedDir: string,
  outputPath: string,
  label: string
): void {
  const relative = path.relative(generatedDir, outputPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new TypeError(
      `[fluxfast] Generated ${label} must stay inside the configured output directory ${JSON.stringify(generatedDir)}; received ${JSON.stringify(outputPath)}`
    );
  }

  let current = generatedDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new TypeError(
          `[fluxfast] Generated ${label} must not traverse the symbolic link ${JSON.stringify(current)}`
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}

function assertSafePageFile(file: string): void {
  const hasTraversalSegment = file
    .split("/")
    .some(segment => segment === "." || segment === "..");
  if (!SAFE_PAGE_FILE.test(file) || hasTraversalSegment) {
    throw new TypeError(
      `[fluxfast] Page path contains unsupported characters: ${JSON.stringify(file)}`
    );
  }
}

/** Render the deterministic registry in memory without modifying the project. */
export function createPagesRegistrySnapshot(
  options: GenerateOptions = {}
): PagesRegistrySnapshot {
  const rootDir = process.cwd();
  const pagesDir = path.resolve(rootDir, options.pagesDir ?? "src/flux-pages");
  const outputFile = path.resolve(
    rootDir,
    options.outputFile ?? "src/.fluxfast/pages.generated.ts"
  );

  const foundFiles: string[] = [];
  const scanDir = (dir: string, base = ""): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = base ? `${base}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, relative);
      } else if (
        entry.isFile() &&
        PAGE_EXTENSION.test(entry.name) &&
        !IGNORED_PAGE.test(entry.name) &&
        !entry.name.startsWith("_")
      ) {
        assertSafePageFile(relative);
        foundFiles.push(relative);
      }
    }
  };

  if (fs.existsSync(pagesDir)) {
    scanDir(pagesDir);
  }
  foundFiles.sort();

  const identifiers = foundFiles.map(file => file.replace(PAGE_EXTENSION, ""));
  const identifierFiles = new Map<string, string>();
  for (let index = 0; index < identifiers.length; index += 1) {
    const identifier = identifiers[index];
    const file = foundFiles[index];
    const previous = identifierFiles.get(identifier);
    if (previous) {
      throw new TypeError(
        `[fluxfast] Duplicate FluxFast page identifier ${JSON.stringify(identifier)} from ${JSON.stringify(previous)} and ${JSON.stringify(file)}`
      );
    }
    identifierFiles.set(identifier, file);
  }

  const outputDir = path.dirname(outputFile);
  const entries = foundFiles.map((file, index) => {
    const identifier = identifiers[index];
    const relativeImport = path
      .relative(outputDir, path.join(pagesDir, file))
      .replace(PAGE_EXTENSION, "")
      .replace(/\\/g, "/");
    const importPath = relativeImport.startsWith(".")
      ? relativeImport
      : `./${relativeImport}`;
    return `  ${JSON.stringify(identifier)}: { load: () => import(${JSON.stringify(importPath)}) },`;
  });

  const content = `// AUTO-GENERATED BY FLUXFAST.\n// DO NOT EDIT MANUALLY.\n"use client";\n\nimport React from "react";\nimport { FluxRoot } from "@fluxfast/next";\nimport type { ComponentRegistry, FluxApplicationProps } from "@fluxfast/next";\n\nexport const fluxPages: ComponentRegistry = {\n${entries.join("\n")}\n};\n\nexport function FluxApplication(props: FluxApplicationProps) {\n  return React.createElement(FluxRoot, { ...props, registry: fluxPages });\n}\n\nexport default fluxPages;\n`;

  return { content, files: foundFiles, identifiers, outputFile, pagesDir };
}

export function generatePagesRegistry(options: GenerateOptions = {}): void {
  const snapshot = createPagesRegistrySnapshot(options);
  assertGeneratedOutputPath(
    path.dirname(snapshot.outputFile),
    snapshot.outputFile,
    "component registry"
  );
  fs.mkdirSync(snapshot.pagesDir, { recursive: true });
  fs.mkdirSync(path.dirname(snapshot.outputFile), { recursive: true });

  fs.writeFileSync(snapshot.outputFile, snapshot.content, "utf8");
  if (options.log !== false) {
    console.log(
      `[fluxfast] Generated component registry with ${snapshot.files.length} pages at ${snapshot.outputFile}`
    );
  }
}

/** Compile every project artifact in memory without modifying the project. */
function createFluxFastProjectSnapshot(
  options: FluxFastGenerationOptions = {}
): FluxFastProjectSnapshot {
  const registry = createPagesRegistrySnapshot(options);
  const generatedDir = path.resolve(
    options.generatedDir ?? path.dirname(registry.outputFile)
  );
  assertGeneratedOutputPath(
    generatedDir,
    registry.outputFile,
    "component registry"
  );
  const candidateSchemaFile = path.resolve(
    options.schemaFile ?? path.join(generatedDir, "schema.generated.json")
  );
  if (options.schemaContent !== undefined) {
    assertGeneratedOutputPath(
      generatedDir,
      candidateSchemaFile,
      "schema manifest"
    );
  }
  const schemaContent = options.schemaContent ?? (
    fs.existsSync(candidateSchemaFile)
      ? fs.readFileSync(candidateSchemaFile, "utf8")
      : undefined
  );
  const hasSchema = schemaContent !== undefined;
  const artifacts: FluxFastGeneratedArtifact[] = [
    { path: registry.outputFile, content: registry.content }
  ];
  let generatedValidators: readonly string[] = Object.freeze([]);
  let validatorDiagnostics: readonly ValidatorCompilationDiagnostic[] = Object.freeze([]);

  if (hasSchema) {
    const manifest = parseFluxFastSchemaManifest(schemaContent);
    const validators = compileFluxFastValidatorsWithDiagnostics(manifest);
    generatedValidators = validators.contracts;
    validatorDiagnostics = validators.diagnostics;
    const schemaArtifacts = [
      {
        path: path.join(generatedDir, "types.generated.ts"),
        content: compileFluxFastResourceTypes(manifest),
        label: "resource types"
      },
      {
        path: path.join(generatedDir, "validators.generated.ts"),
        content: validators.content,
        label: "validators"
      },
      {
        path: path.join(generatedDir, "routes.generated.ts"),
        content: compileFluxFastPageRoutes(manifest),
        label: "page routes"
      },
      {
        path: path.join(generatedDir, "mutations.generated.ts"),
        content: compileFluxFastMutations(manifest),
        label: "mutation helpers"
      }
    ];
    for (const artifact of schemaArtifacts) {
      assertGeneratedOutputPath(generatedDir, artifact.path, artifact.label);
      artifacts.push({ path: artifact.path, content: artifact.content });
    }
  }

  return {
    artifacts,
    generatedValidators,
    generatedDir,
    pagesDir: registry.pagesDir,
    registryPath: registry.outputFile,
    schemaContent: options.schemaContent,
    schemaFile: hasSchema ? candidateSchemaFile : undefined,
    validatorDiagnostics
  };
}

/** Generate the page registry and any schema-backed developer artifacts. */
export function generateFluxFastProject(
  options: FluxFastGenerationOptions = {}
): FluxFastGenerationResult {
  const snapshot = createFluxFastProjectSnapshot(options);

  // Compile every artifact before writing any of them so an invalid manifest
  // cannot leave the generated directory partially updated.
  fs.mkdirSync(snapshot.pagesDir, { recursive: true });
  if (snapshot.schemaContent !== undefined && snapshot.schemaFile) {
    fs.mkdirSync(path.dirname(snapshot.schemaFile), { recursive: true });
    fs.writeFileSync(snapshot.schemaFile, snapshot.schemaContent, "utf8");
  }
  for (const artifact of snapshot.artifacts) {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, artifact.content, "utf8");
  }

  if (options.log !== false) {
    console.log(
      `[fluxfast] Generated ${snapshot.artifacts.length} file${snapshot.artifacts.length === 1 ? "" : "s"} in ${snapshot.generatedDir}`
    );
  }
  return {
    generatedFiles: snapshot.artifacts.map(artifact => artifact.path),
    generatedValidators: snapshot.generatedValidators,
    registryPath: snapshot.registryPath,
    schemaFile: snapshot.schemaFile,
    validatorDiagnostics: snapshot.validatorDiagnostics
  };
}

/** Check deterministic project artifacts without creating or modifying files. */
export function checkFluxFastProject(
  options: FluxFastGenerationOptions = {}
): FluxFastGenerationCheckResult {
  const snapshot = createFluxFastProjectSnapshot(options);
  const checkedFiles = snapshot.artifacts.map(artifact => artifact.path);
  const staleFiles = snapshot.artifacts
    .filter(artifact => {
      try {
        return fs.readFileSync(artifact.path, "utf8") !== artifact.content;
      } catch {
        return true;
      }
    })
    .map(artifact => artifact.path);
  if (snapshot.schemaContent !== undefined && snapshot.schemaFile) {
    checkedFiles.unshift(snapshot.schemaFile);
    try {
      if (
        fs.readFileSync(snapshot.schemaFile, "utf8") !== snapshot.schemaContent
      ) {
        staleFiles.unshift(snapshot.schemaFile);
      }
    } catch {
      staleFiles.unshift(snapshot.schemaFile);
    }
  }

  return {
    checkedFiles,
    current: staleFiles.length === 0,
    generatedValidators: snapshot.generatedValidators,
    registryPath: snapshot.registryPath,
    schemaFile: snapshot.schemaFile,
    staleFiles,
    validatorDiagnostics: snapshot.validatorDiagnostics
  };
}
