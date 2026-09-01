import fs from "node:fs";
import path from "node:path";
import {
  checkFluxFastProject,
  createPagesRegistrySnapshot,
} from "../generate";
import { compileInlineJsonSchemaType } from "../schema-compiler";
import {
  type FluxFastSchemaManifest,
  parseFluxFastSchemaManifest,
  SchemaManifestValidationError,
} from "../schema-manifest";
import { desiredCatchAllPath, isFluxCatchAll } from "./files";
import { transformNextConfig } from "./next-config";
import type {
  CompatibilityStatus,
  DetectedPackage,
  FluxProjectInfo,
} from "./types";

export type DiagnosticSection =
  | "Environment"
  | "Packages"
  | "Types"
  | "Project"
  | "Configuration"
  | "Pages"
  | "Registry";

export type DiagnosticStatus = "pass" | "warning" | "fail";

export interface FluxDiagnostic {
  id: string;
  section: DiagnosticSection;
  status: DiagnosticStatus;
  message: string;
  blocksCheck?: boolean;
  fix?: string;
}

export interface FluxValidationReport {
  diagnostics: FluxDiagnostic[];
  pages: string[];
  valid: boolean;
}

export interface ValidationOptions {
  includeTypeDiagnostics?: boolean;
  nodeVersion?: string;
}

function diagnostic(
  id: string,
  section: DiagnosticSection,
  status: DiagnosticStatus,
  message: string,
  options: Pick<FluxDiagnostic, "blocksCheck" | "fix"> = {}
): FluxDiagnostic {
  return { id, section, status, message, ...options };
}

function packageVersion(pkg: DetectedPackage): string {
  return pkg.installedVersion ?? pkg.declaredVersion ?? "unknown";
}

function packageDiagnostic(
  id: string,
  label: string,
  pkg: DetectedPackage,
  supportedDescription: string,
  missingFix: string
): FluxDiagnostic {
  if (!pkg.effectiveVersion) {
    return diagnostic(id, "Packages", "fail", `${label} is not installed or declared.`, {
      fix: missingFix,
    });
  }
  if (pkg.compatibility === "unsupported") {
    return diagnostic(
      id,
      "Packages",
      "fail",
      `Unsupported ${label} version: ${packageVersion(pkg)}. Expected ${supportedDescription}.`,
      { fix: missingFix }
    );
  }
  if (pkg.compatibility === "unknown") {
    return diagnostic(
      id,
      "Packages",
      "warning",
      `${label} version could not be verified: ${packageVersion(pkg)}.`
    );
  }
  return diagnostic(
    id,
    "Packages",
    "pass",
    `${label} ${packageVersion(pkg)}${pkg.compatibility === "probably-supported" ? " (declared range)" : ""}`
  );
}

export function validateInitPrerequisites(
  project: FluxProjectInfo,
  options: ValidationOptions = {}
): FluxDiagnostic[] {
  const diagnostics: FluxDiagnostic[] = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
  diagnostics.push(
    nodeMajor === 22 || nodeMajor === 24
      ? diagnostic("environment.node", "Environment", "pass", `Node ${nodeVersion}`)
      : diagnostic(
          "environment.node",
          "Environment",
          "fail",
          `Unsupported Node version: ${nodeVersion}. Expected Node 22 or 24.`
        )
  );

  diagnostics.push(
    packageDiagnostic(
      "package.next",
      "Next.js",
      project.packages.next,
      ">=16.3.0 <17.0.0",
      "npm install next@^16.3.0"
    ),
    packageDiagnostic(
      "package.react",
      "React",
      project.packages.react,
      ">=19.0.0",
      "npm install react@^19 react-dom@^19"
    ),
    packageDiagnostic(
      "package.react-dom",
      "React DOM",
      project.packages.reactDom,
      ">=19.0.0",
      "npm install react@^19 react-dom@^19"
    ),
    packageDiagnostic(
      "package.fluxfast-next",
      "@fluxfast/next",
      project.packages.fluxfastNext,
      "an installed FluxFast release",
      "npm install @fluxfast/next"
    ),
    packageDiagnostic(
      "package.fluxfast-core",
      "@fluxfast/core",
      project.packages.fluxfastCore,
      "the version installed by @fluxfast/next",
      "npm install @fluxfast/next"
    )
  );

  diagnostics.push(
    project.hasAppRouter
      ? diagnostic(
          "project.app-router",
          "Project",
          "pass",
          `App Router at ${path.relative(project.root, project.appDir)}`
        )
      : diagnostic(
          "project.app-router",
          "Project",
          "fail",
          project.pagesRouterDir
            ? `FluxFast requires the Next.js App Router; Pages Router detected at ${path.relative(project.root, project.pagesRouterDir)}.`
            : "App Router was not found; expected app/ or src/app/.",
          { fix: "Create a Next.js App Router project" }
        ),
    diagnostic(
      "project.layout",
      "Project",
      "pass",
      project.usesSrcDirectory ? "src/ layout" : "root layout"
    ),
    diagnostic(
      "project.language",
      "Project",
      "pass",
      project.language === "typescript" ? "TypeScript" : "JavaScript"
    )
  );

  if (project.nextConfigPaths.length > 1) {
    diagnostics.push(
      diagnostic(
        "config.next-duplicates",
        "Configuration",
        "fail",
        "Multiple next.config files were detected; keep only the active one."
      )
    );
  }
  if (project.configPaths.length > 1) {
    diagnostics.push(
      diagnostic(
        "config.fluxfast-duplicates",
        "Configuration",
        "fail",
        "Multiple fluxfast.config files were detected; keep only the active one."
      )
    );
  }
  return diagnostics;
}

function readFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isBlocking(item: FluxDiagnostic): boolean {
  return item.status === "fail" || item.blocksCheck === true;
}

function findAppPageFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const pages: string[] = [];
  const scan = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        scan(target);
      } else if (entry.isFile() && /^page\.(?:tsx?|jsx?)$/.test(entry.name)) {
        pages.push(target);
      }
    }
  };
  scan(directory);
  return pages.sort();
}

function routeForAppPage(appDir: string, pageFile: string): string {
  const directory = path.relative(appDir, path.dirname(pageFile));
  const segments = directory === "." ? [] : directory.split(path.sep);
  const routeSegments = segments.filter(
    segment =>
      !(segment.startsWith("(") && segment.endsWith(")")) &&
      !segment.startsWith("@")
  );
  return routeSegments.length > 0 ? `/${routeSegments.join("/")}` : "/";
}

function countMessage(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function validateTypeGeneration(project: FluxProjectInfo): FluxDiagnostic[] {
  const diagnostics: FluxDiagnostic[] = [];
  const schemaFile = path.join(project.generatedDir, "schema.generated.json");
  const relativeSchemaFile = path.relative(project.root, schemaFile);
  const source = readFile(schemaFile);
  if (source === undefined) {
    diagnostics.push(
      diagnostic(
        "types.manifest",
        "Types",
        "warning",
        fs.existsSync(schemaFile)
          ? `Schema manifest could not be read at ${relativeSchemaFile}.`
          : `fluxfast-schema/1 manifest was not found at ${relativeSchemaFile}.`
      )
    );
    return diagnostics;
  }

  let manifest: FluxFastSchemaManifest;
  try {
    manifest = parseFluxFastSchemaManifest(source);
  } catch (error) {
    const unsupportedVersion =
      error instanceof SchemaManifestValidationError &&
      error.path === "$.schema" &&
      error.message.includes("unsupported version");
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      diagnostic(
        "types.manifest",
        "Types",
        "warning",
        unsupportedVersion
          ? `Schema manifest version is unsupported. ${message}`
          : `Schema manifest is invalid. ${message}`
      )
    );
    return diagnostics;
  }

  diagnostics.push(
    diagnostic(
      "types.manifest",
      "Types",
      "pass",
      `fluxfast-schema/1 manifest found at ${relativeSchemaFile}`
    ),
    diagnostic(
      "types.resources",
      "Types",
      "pass",
      countMessage(
        Object.keys(manifest.resources).length,
        "typed resource",
        "typed resources"
      )
    ),
    diagnostic(
      "types.routes",
      "Types",
      "pass",
      countMessage(manifest.pages.length, "page route", "page routes")
    ),
    diagnostic(
      "types.mutations",
      "Types",
      "pass",
      countMessage(
        manifest.mutations.length,
        "mutation operation",
        "mutation operations"
      )
    )
  );

  try {
    const unknownResources = Object.entries(manifest.resources)
      .filter(([key, entry]) =>
        /\bunknown\b/.test(
          compileInlineJsonSchemaType(
            entry.schema,
            `$.resources[${JSON.stringify(key)}].schema`
          )
        )
      )
      .map(([key]) => key);
    if (unknownResources.length > 0) {
      diagnostics.push(
        diagnostic(
          "types.unknown",
          "Types",
          "warning",
          unknownResources.length === 1
            ? `Resource ${JSON.stringify(unknownResources[0])} contains an unconstrained schema and maps to unknown.`
            : `${unknownResources.length} resources contain unconstrained schemas and map to unknown: ${unknownResources.map(key => JSON.stringify(key)).join(", ")}.`
        )
      );
    }

    const result = checkFluxFastProject({
      pagesDir: project.fluxPagesDir,
      outputFile: project.registryPath,
      generatedDir: project.generatedDir,
      schemaFile,
      log: false,
    });
    const staleTypeFiles = result.staleFiles.filter(
      file => file !== result.registryPath
    );
    diagnostics.push(
      staleTypeFiles.length === 0
        ? diagnostic(
            "types.generated",
            "Types",
            "pass",
            "Generated TypeScript is current"
          )
        : diagnostic(
            "types.generated",
            "Types",
            "warning",
            `${countMessage(staleTypeFiles.length, "generated TypeScript file is", "generated TypeScript files are")} stale or missing.`,
            { fix: "npx fluxfast generate" }
          )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      diagnostic(
        "types.generated",
        "Types",
        "warning",
        `Generated TypeScript could not be verified. ${message}`
      )
    );
  }

  return diagnostics;
}

export function validateFluxProject(
  project: FluxProjectInfo,
  options: ValidationOptions = {}
): FluxValidationReport {
  const diagnostics = validateInitPrerequisites(project, options);
  const configContent = readFile(project.configPath);
  if (!configContent) {
    diagnostics.push(
      diagnostic(
        "config.fluxfast",
        "Configuration",
        "fail",
        "FluxFast config is missing.",
        { fix: "npx fluxfast init" }
      )
    );
  } else if (
    !/\bexport\s+(?:const|let|var)\s+fluxConfig\b|\bexport\s*\{[^}]*\bfluxConfig\b[^}]*\}/s.test(
      configContent
    )
  ) {
    diagnostics.push(
      diagnostic(
        "config.fluxfast",
        "Configuration",
        "fail",
        "FluxFast config does not export fluxConfig.",
        { fix: "Export a valid fluxConfig from the detected config file" }
      )
    );
  } else {
    diagnostics.push(
      diagnostic(
        "config.fluxfast",
        "Configuration",
        "pass",
        `FluxFast config at ${path.relative(project.root, project.configPath)}`
      )
    );
  }

  if (!project.nextConfigPath || !project.nextConfigFormat) {
    diagnostics.push(
      diagnostic("config.next", "Configuration", "fail", "Next config is missing.", {
        fix: "npx fluxfast init",
      })
    );
  } else {
    const nextContent = readFile(project.nextConfigPath);
    const transformed = nextContent
      ? transformNextConfig(nextContent, project.nextConfigFormat)
      : undefined;
    diagnostics.push(
      transformed?.status === "unchanged"
        ? diagnostic(
            "config.next",
            "Configuration",
            "pass",
            `${path.relative(project.root, project.nextConfigPath)} uses withFluxFast()`
          )
        : diagnostic(
            "config.next",
            "Configuration",
            "fail",
            "Next config does not use withFluxFast().",
            { fix: "npx fluxfast init" }
          )
    );
  }

  const catchAllPath = desiredCatchAllPath(project);
  const catchAllContent = readFile(catchAllPath);
  diagnostics.push(
    catchAllContent && isFluxCatchAll(catchAllContent)
      ? diagnostic(
          "config.catch-all",
          "Configuration",
          "pass",
          `FluxFast catch-all at ${path.relative(project.root, catchAllPath)}`
        )
      : diagnostic(
          "config.catch-all",
          "Configuration",
          "fail",
          "FluxFast catch-all is missing or invalid.",
          {
            fix: catchAllContent
              ? "npx fluxfast init --force"
              : "npx fluxfast init",
          }
        )
  );

  if (project.rootPagePath) {
    diagnostics.push(
      diagnostic(
        "routes.shadowing-root",
        "Pages",
        "warning",
        `${path.relative(project.root, project.rootPagePath)} shadows FluxFast route "/".`,
        {
          blocksCheck: true,
          fix: `Move it into ${path.relative(project.root, project.fluxPagesDir)}/home/index and remove the Next route`,
        }
      )
    );
  } else {
    diagnostics.push(
      diagnostic("routes.shadowing-root", "Pages", "pass", "No root route conflict")
    );
  }

  const catchAllPathForConflict = path.resolve(desiredCatchAllPath(project));
  for (const pageFile of findAppPageFiles(project.appDir)) {
    if (
      path.resolve(pageFile) === catchAllPathForConflict ||
      (project.rootPagePath && path.resolve(pageFile) === path.resolve(project.rootPagePath))
    ) {
      continue;
    }
    const route = routeForAppPage(project.appDir, pageFile);
    diagnostics.push(
      diagnostic(
        "routes.shadowing",
        "Pages",
        "warning",
        `${path.relative(project.root, pageFile)} shadows FluxFast route ${JSON.stringify(route)}.`,
        {
          blocksCheck: true,
          fix: `Move the component into ${path.relative(project.root, project.fluxPagesDir)} and remove the Next route`,
        }
      )
    );
  }

  let pages: string[] = [];
  try {
    const snapshot = createPagesRegistrySnapshot({
      pagesDir: project.fluxPagesDir,
      outputFile: project.registryPath,
      log: false,
    });
    pages = snapshot.identifiers;
    diagnostics.push(
      diagnostic(
        "pages.valid",
        "Pages",
        pages.length > 0 ? "pass" : "warning",
        `${pages.length} FluxFast page${pages.length === 1 ? "" : "s"} registered`
      )
    );

    const registryContent = readFile(project.registryPath);
    if (registryContent === undefined) {
      diagnostics.push(
        diagnostic("registry.current", "Registry", "fail", "Registry is missing.", {
          fix: "npx fluxfast generate",
        })
      );
    } else if (registryContent !== snapshot.content) {
      diagnostics.push(
        diagnostic(
          "registry.current",
          "Registry",
          "fail",
          "Registry appears stale.",
          { fix: "npx fluxfast generate" }
        )
      );
    } else {
      diagnostics.push(
        diagnostic(
          "registry.current",
          "Registry",
          "pass",
          `Registry is up-to-date with ${pages.length} page${pages.length === 1 ? "" : "s"}`
        )
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      diagnostic("pages.valid", "Pages", "fail", message, {
        fix: "Resolve duplicate or invalid files in flux-pages",
      })
    );
  }

  if (options.includeTypeDiagnostics) {
    diagnostics.push(...validateTypeGeneration(project));
  }

  return {
    diagnostics,
    pages,
    valid: !diagnostics.some(isBlocking),
  };
}
