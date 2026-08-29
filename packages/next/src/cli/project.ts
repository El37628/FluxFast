import fs from "node:fs";
import path from "node:path";
import type {
  CompatibilityStatus,
  DetectedPackage,
  DetectedPackageName,
  FluxProjectInfo,
  NextConfigFormat,
  ProjectLanguage,
} from "./types";

type JsonRecord = Record<string, unknown>;

const NEXT_CONFIGS: ReadonlyArray<readonly [string, NextConfigFormat]> = [
  ["next.config.ts", "ts"],
  ["next.config.js", "js"],
  ["next.config.mjs", "mjs"],
  ["next.config.cjs", "cjs"],
];

const PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export class ProjectDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDetectionError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function findProjectRoot(startPath: string): {
  root: string;
  packageJsonPath: string;
} {
  let current = path.resolve(startPath);
  if (isFile(current)) {
    current = path.dirname(current);
  }

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (isFile(packageJsonPath)) {
      return { root: current, packageJsonPath };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new ProjectDetectionError(
        `Could not find package.json from ${path.resolve(startPath)} or any parent directory.`
      );
    }
    current = parent;
  }
}

function readJsonRecord(filePath: string, description: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new ProjectDetectionError(
      `Could not read ${description} at ${filePath}.${detail}`
    );
  }

  if (!isRecord(parsed)) {
    throw new ProjectDetectionError(
      `Expected ${description} at ${filePath} to contain a JSON object.`
    );
  }
  return parsed;
}

function readDeclaredVersion(
  packageJson: JsonRecord,
  packageName: DetectedPackageName
): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!isRecord(dependencies)) {
      continue;
    }
    const version = dependencies[packageName];
    if (typeof version === "string") {
      return version;
    }
  }
  return undefined;
}

function readInstalledVersion(
  root: string,
  packageName: DetectedPackageName
): string | undefined {
  const packagePath = path.join(
    root,
    "node_modules",
    ...packageName.split("/"),
    "package.json"
  );
  if (!isFile(packagePath)) {
    return undefined;
  }

  try {
    const packageJson: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (isRecord(packageJson) && typeof packageJson.version === "string") {
      return packageJson.version;
    }
  } catch {
    // A broken node_modules entry is reported as an unknown installed version.
  }
  return undefined;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseExactVersion(version: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    version.trim()
  );
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function firstVersionInRange(version: string): ParsedVersion | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function isSupportedExact(
  packageName: DetectedPackageName,
  version: ParsedVersion
): boolean {
  if (packageName === "next") {
    return (
      version.major === 16 &&
      (version.minor > 3 || (version.minor === 3 && version.patch >= 0))
    );
  }
  if (packageName === "react" || packageName === "react-dom") {
    return version.major >= 19;
  }
  return true;
}

/**
 * Classify package specs without executing a package manager or project code.
 * Exact installed versions can be definitive; ranges remain "probably" valid.
 */
export function classifyPackageCompatibility(
  packageName: DetectedPackageName,
  version: string | undefined
): CompatibilityStatus {
  if (!version) {
    return "unknown";
  }

  const trimmed = version.trim();
  const exact = parseExactVersion(trimmed);
  if (exact) {
    return isSupportedExact(packageName, exact) ? "supported" : "unsupported";
  }

  if (packageName === "@fluxfast/next" && trimmed.startsWith("workspace:")) {
    return "probably-supported";
  }

  const ranged = firstVersionInRange(trimmed);
  if (!ranged) {
    return "unknown";
  }

  if (packageName === "next") {
    if (ranged.major !== 16 || ranged.minor < 3) {
      return "unsupported";
    }
    return "probably-supported";
  }

  if (packageName === "react" || packageName === "react-dom") {
    return ranged.major >= 19 ? "probably-supported" : "unsupported";
  }

  return "probably-supported";
}

function detectPackage(
  root: string,
  packageJson: JsonRecord,
  name: DetectedPackageName
): DetectedPackage {
  const declaredVersion = readDeclaredVersion(packageJson, name);
  const installedVersion = readInstalledVersion(root, name);
  const effectiveVersion = installedVersion ?? declaredVersion;
  return {
    name,
    declaredVersion,
    installedVersion,
    effectiveVersion,
    compatibility: classifyPackageCompatibility(name, effectiveVersion),
  };
}

function containsTsx(directoryPath: string): boolean {
  if (!isDirectory(directoryPath)) {
    return false;
  }

  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tsx")) {
      return true;
    }
    if (
      entry.isDirectory() &&
      entry.name !== "node_modules" &&
      entry.name !== ".next" &&
      entry.name !== ".git" &&
      containsTsx(path.join(directoryPath, entry.name))
    ) {
      return true;
    }
  }
  return false;
}

function detectLanguage(root: string): ProjectLanguage {
  if (
    isFile(path.join(root, "tsconfig.json")) ||
    isFile(path.join(root, "next.config.ts")) ||
    isFile(path.join(root, "fluxfast.config.ts")) ||
    isFile(path.join(root, "src", "fluxfast.config.ts")) ||
    containsTsx(path.join(root, "src")) ||
    containsTsx(path.join(root, "app")) ||
    containsTsx(path.join(root, "pages"))
  ) {
    return "typescript";
  }
  return "javascript";
}

function detectFluxConfig(
  sourceRoot: string,
  language: ProjectLanguage
): { configPath: string; configPaths: string[] } {
  const candidates = ["fluxfast.config.ts", "fluxfast.config.js"]
    .map(file => path.join(sourceRoot, file))
    .filter(isFile);
  const preferredExtension = language === "typescript" ? ".ts" : ".js";
  const preferred = candidates.find(candidate =>
    candidate.endsWith(preferredExtension)
  );

  return {
    configPath:
      preferred ??
      candidates[0] ??
      path.join(sourceRoot, `fluxfast.config${preferredExtension}`),
    configPaths: candidates,
  };
}

function detectAtAlias(root: string, usesSrcDirectory: boolean): boolean {
  const configPath = ["tsconfig.json", "jsconfig.json"]
    .map(file => path.join(root, file))
    .find(isFile);
  if (!configPath) {
    return false;
  }

  const content = fs.readFileSync(configPath, "utf8");
  const aliasMatch = /["']@\/\*["']\s*:\s*\[\s*["']([^"']+)["']/.exec(
    content
  );
  if (!aliasMatch) {
    return false;
  }

  const normalizedTarget = aliasMatch[1].replace(/\\/g, "/").replace(/^\.\//, "");
  return usesSrcDirectory
    ? normalizedTarget === "src/*"
    : normalizedTarget === "*";
}

function findPageFile(directory: string): string | undefined {
  for (const extension of PAGE_EXTENSIONS) {
    const candidate = path.join(directory, `page.${extension}`);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function detectSourceLayout(root: string): {
  usesSrcDirectory: boolean;
  hasAppRouter: boolean;
  appDir: string;
  pagesRouterDir?: string;
} {
  const srcApp = path.join(root, "src", "app");
  const rootApp = path.join(root, "app");
  const srcPages = path.join(root, "src", "pages");
  const rootPages = path.join(root, "pages");

  const hasSrcApp = isDirectory(srcApp);
  const hasRootApp = isDirectory(rootApp);
  const pagesRouterDir = isDirectory(srcPages)
    ? srcPages
    : isDirectory(rootPages)
      ? rootPages
      : undefined;
  const usesSrcDirectory =
    hasSrcApp ||
    (!hasRootApp && isDirectory(srcPages)) ||
    (!hasRootApp && !isDirectory(rootPages) && isDirectory(path.join(root, "src")));

  return {
    usesSrcDirectory,
    hasAppRouter: hasSrcApp || hasRootApp,
    appDir: hasSrcApp ? srcApp : hasRootApp ? rootApp : usesSrcDirectory ? srcApp : rootApp,
    pagesRouterDir,
  };
}

/** Analyze a Next.js project without importing project code or modifying files. */
export function detectFluxProject(startPath = process.cwd()): FluxProjectInfo {
  const { root, packageJsonPath } = findProjectRoot(startPath);
  const packageJson = readJsonRecord(packageJsonPath, "package.json");
  const layout = detectSourceLayout(root);
  const language = detectLanguage(root);
  const sourceRoot = layout.usesSrcDirectory ? path.join(root, "src") : root;
  const fluxConfig = detectFluxConfig(sourceRoot, language);
  const nextConfigs = NEXT_CONFIGS.filter(([file]) => isFile(path.join(root, file)));
  const [nextConfig] = nextConfigs;
  const catchAllDirectory = path.join(
    layout.appDir,
    "(flux)",
    "[[...flux]]"
  );

  return {
    root,
    packageJsonPath,
    usesSrcDirectory: layout.usesSrcDirectory,
    hasAppRouter: layout.hasAppRouter,
    appDir: layout.appDir,
    pagesRouterDir: layout.pagesRouterDir,
    fluxPagesDir: path.join(sourceRoot, "flux-pages"),
    generatedDir: path.join(sourceRoot, ".fluxfast"),
    registryPath: path.join(sourceRoot, ".fluxfast", "pages.generated.ts"),
    configPath: fluxConfig.configPath,
    configPaths: fluxConfig.configPaths,
    nextConfigPath: nextConfig ? path.join(root, nextConfig[0]) : undefined,
    nextConfigFormat: nextConfig?.[1],
    nextConfigPaths: nextConfigs.map(([file]) => path.join(root, file)),
    language,
    usesAtAlias: detectAtAlias(root, layout.usesSrcDirectory),
    rootPagePath: findPageFile(layout.appDir),
    catchAllPath: findPageFile(catchAllDirectory),
    packages: {
      next: detectPackage(root, packageJson, "next"),
      react: detectPackage(root, packageJson, "react"),
      reactDom: detectPackage(root, packageJson, "react-dom"),
      fluxfastNext: detectPackage(root, packageJson, "@fluxfast/next"),
    },
  };
}
