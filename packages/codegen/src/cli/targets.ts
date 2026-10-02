import path from "node:path";
import type { FluxPageRegistryTarget } from "../pages-registry.js";
import { isDirectory } from "./project.js";

interface CodegenProjectPaths {
  pagesDir: string;
  generatedDir: string;
  registryPath: string;
}

interface CodegenCliTarget {
  registry: Readonly<FluxPageRegistryTarget>;
  projectPaths: (root: string) => CodegenProjectPaths;
}

const NEXT_CODEGEN_TARGET: CodegenCliTarget = Object.freeze({
  registry: Object.freeze({
    runtimeImport: "@fluxfast/next",
    rootExport: "FluxRoot",
    applicationPropsExport: "FluxApplicationProps",
    clientDirective: true,
  }),
  projectPaths(root: string): CodegenProjectPaths {
    // Preserve the existing Next CLI's root/src precedence and fallbacks.
    const hasRootApp = isDirectory(path.join(root, "app"));
    const usesSrc = isDirectory(path.join(root, "src/app")) ||
      (!hasRootApp && isDirectory(path.join(root, "src/pages"))) ||
      (!hasRootApp && !isDirectory(path.join(root, "pages")) && isDirectory(path.join(root, "src")));
    const sourceRoot = usesSrc ? path.join(root, "src") : root;
    const generatedDir = path.join(sourceRoot, ".fluxfast");
    return {
      pagesDir: path.join(sourceRoot, "flux-pages"),
      generatedDir,
      registryPath: path.join(generatedDir, "pages.generated.ts"),
    };
  },
});

const REACT_CODEGEN_TARGET: CodegenCliTarget = Object.freeze({
  registry: Object.freeze({
    runtimeImport: "@fluxfast/react",
    rootExport: "FluxRoot",
    applicationPropsExport: "FluxApplicationProps",
    clientDirective: false,
  }),
  projectPaths(root: string): CodegenProjectPaths {
    // React/Vite does not use Next's app/pages routing-directory precedence.
    const sourceRoot = isDirectory(path.join(root, "src")) ? path.join(root, "src") : root;
    const generatedDir = path.join(sourceRoot, ".fluxfast");
    return {
      pagesDir: path.join(sourceRoot, "flux-pages"),
      generatedDir,
      registryPath: path.join(generatedDir, "pages.generated.ts"),
    };
  },
});

// Adapter selection belongs here, not in the scanner, compilers, or writer.
const targets: Readonly<Record<string, CodegenCliTarget>> = Object.freeze({
  next: NEXT_CODEGEN_TARGET,
  react: REACT_CODEGEN_TARGET,
});

export function getCodegenTarget(name: string): CodegenCliTarget | undefined {
  return Object.hasOwn(targets, name) ? targets[name] : undefined;
}

export function codegenAdapterNames(): readonly string[] {
  return Object.keys(targets);
}
