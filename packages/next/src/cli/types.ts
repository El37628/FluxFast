export type ProjectLanguage = "typescript" | "javascript";

export type NextConfigFormat = "ts" | "js" | "mjs" | "cjs";

export type CompatibilityStatus =
  | "supported"
  | "probably-supported"
  | "unsupported"
  | "unknown";

export type DetectedPackageName =
  | "next"
  | "react"
  | "react-dom"
  | "@fluxfast/core"
  | "@fluxfast/next";

export interface DetectedPackage {
  name: DetectedPackageName;
  declaredVersion?: string;
  installedVersion?: string;
  effectiveVersion?: string;
  compatibility: CompatibilityStatus;
}

export interface FluxProjectPackages {
  next: DetectedPackage;
  react: DetectedPackage;
  reactDom: DetectedPackage;
  fluxfastCore: DetectedPackage;
  fluxfastNext: DetectedPackage;
}

/** A static, read-only description of a potential FluxFast Next.js project. */
export interface FluxProjectInfo {
  root: string;
  packageJsonPath: string;
  usesSrcDirectory: boolean;
  hasAppRouter: boolean;
  appDir: string;
  pagesRouterDir?: string;
  fluxPagesDir: string;
  generatedDir: string;
  registryPath: string;
  configPath: string;
  configPaths: string[];
  nextConfigPath?: string;
  nextConfigFormat?: NextConfigFormat;
  nextConfigPaths: string[];
  language: ProjectLanguage;
  usesAtAlias: boolean;
  rootPagePath?: string;
  catchAllPath?: string;
  packages: FluxProjectPackages;
}
