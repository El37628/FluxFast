import fs from "node:fs";
import path from "node:path";
import type { PagesRegistrySnapshot } from "./generate.js";

/** The runtime exports selected by a React-style rendering adapter. */
export interface FluxPageRegistryTarget {
  runtimeImport: string;
  rootExport: string;
  applicationPropsExport: string;
  clientDirective?: boolean;
}

export interface PagesRegistryOptions {
  pagesDir?: string;
  outputFile?: string;
  target: FluxPageRegistryTarget;
}

function validateRegistryTarget(target: FluxPageRegistryTarget): FluxPageRegistryTarget {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new TypeError("[fluxfast] Invalid page registry target: an explicit runtime target is required");
  }
  const { runtimeImport, rootExport, applicationPropsExport, clientDirective } = target;
  if (typeof runtimeImport !== "string" || !runtimeImport.trim() || /[\x00-\x1f\x7f]/.test(runtimeImport)) {
    throw new TypeError("[fluxfast] Invalid page registry target runtimeImport: use a non-empty module specifier without control characters");
  }
  for (const [name, value] of Object.entries({ rootExport, applicationPropsExport })) {
    if (typeof value !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
      throw new TypeError("[fluxfast] Invalid page registry target " + name + ": use a JavaScript export identifier");
    }
  }
  if (clientDirective !== undefined && typeof clientDirective !== "boolean") {
    throw new TypeError("[fluxfast] Invalid page registry target clientDirective: use a boolean");
  }
  return { runtimeImport, rootExport, applicationPropsExport, clientDirective };
}

const PAGE_EXTENSION = /\.(tsx|jsx)$/;
const IGNORED_PAGE = /\.(test|spec|stories)\.(tsx|jsx)$/;
const SAFE_PAGE_FILE =
  /^[A-Za-z0-9_.@()\[\]-]+(?:\/[A-Za-z0-9_.@()\[\]-]+)*\.(?:tsx|jsx)$/;

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

// JSON quoting protects JavaScript literals; also escape HTML delimiters and
// Unicode line separators if generated source is embedded in a script context.
function sourceStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** Scan and render a deterministic registry without modifying the project. */
export function createPagesRegistrySnapshot(
  options: PagesRegistryOptions
): PagesRegistrySnapshot {
  const target = validateRegistryTarget(options?.target);
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
    return `  ${sourceStringLiteral(identifier)}: { load: () => import(${sourceStringLiteral(importPath)}) },`;
  });

  const runtimeImport = sourceStringLiteral(target.runtimeImport);
  const rootExport = target.rootExport === "FluxRoot"
    ? "FluxRoot" : `${target.rootExport} as FluxRoot`;
  const propsExport = target.applicationPropsExport === "FluxApplicationProps"
    ? "FluxApplicationProps" : `${target.applicationPropsExport} as FluxApplicationProps`;
  const directive = target.clientDirective === true ? '"use client";\n' : "";
  const content = `// AUTO-GENERATED BY FLUXFAST.\n// DO NOT EDIT MANUALLY.\n${directive}\nimport React from "react";\nimport { ${rootExport} } from ${runtimeImport};\nimport type { ComponentRegistry, ${propsExport} } from ${runtimeImport};\n\nexport const fluxPages: ComponentRegistry = {\n${entries.join("\n")}\n};\n\nexport function FluxApplication(props: FluxApplicationProps) {\n  return React.createElement(FluxRoot, { ...props, registry: fluxPages });\n}\n\nexport default fluxPages;\n`;

  return { content, files: foundFiles, identifiers, outputFile, pagesDir };
}
