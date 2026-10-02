import fs from "node:fs";
import path from "node:path";
import { checkFluxFastProject, createPagesRegistrySnapshot, generateFluxFastProject } from "@fluxfast/codegen";
import { assertSafePath, GENERATED_ARTIFACTS, type FrontendProject } from "./project.js";

export function generationOptions(project: FrontendProject, schemaFile?: string) {
  assertSafePath(project.root, project.pages);
  assertSafePath(project.root, project.registry);
  // The existing schema is also an input; do not read it through a symlink.
  for (const name of GENERATED_ARTIFACTS) assertSafePath(project.root, path.join(project.generated, name));
  return {
    registry: createPagesRegistrySnapshot({ pagesDir: project.pages, outputFile: project.registry,
      target: { runtimeImport: "@fluxfast/react", rootExport: "FluxRoot", applicationPropsExport: "FluxApplicationProps", clientDirective: false } }),
    generatedDir: project.generated, log: false,
    ...(schemaFile === undefined ? {} : { schemaContent: fs.readFileSync(path.resolve(project.root, schemaFile), "utf8") }),
  };
}

export function generateProject(project: FrontendProject, check: boolean, schemaFile?: string): { current: boolean; files: readonly string[] } {
  const options = generationOptions(project, schemaFile);
  if (check) {
    const result = checkFluxFastProject(options);
    return { current: result.current, files: result.staleFiles };
  }
  return { current: true, files: generateFluxFastProject(options).generatedFiles };
}

/** Compile existing contracts before initialization can write any scaffold. */
export function validateGeneration(project: FrontendProject): void {
  checkFluxFastProject(generationOptions(project));
}
