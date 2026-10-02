import fs from "node:fs";
import path from "node:path";

export const HOST_CONFIG = "fluxfast.vite.config.mjs";
export const HOST_TEMPLATE = "fluxfast.html";
export const GENERATED_ARTIFACTS = Object.freeze([
  "pages.generated.ts", "schema.generated.json", "types.generated.ts",
  "validators.generated.ts", "routes.generated.ts", "mutations.generated.ts",
]);
export const HOST_SCRIPTS = Object.freeze({
  "fluxfast:dev": `fluxfast-vite dev --config ${HOST_CONFIG}`,
  "fluxfast:build": `fluxfast-vite build --config ${HOST_CONFIG}`,
  "fluxfast:start": "fluxfast-vite start",
});

export interface FrontendProject {
  root: string;
  source: string;
  pages: string;
  generated: string;
  registry: string;
  manifest: Record<string, unknown>;
  manifestContent: string;
}

export function projectAt(start: string): FrontendProject {
  let root = path.resolve(start);
  while (!fs.existsSync(path.join(root, "package.json"))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error("No frontend package.json found in this directory or its parents");
    root = parent;
  }
  assertSafePath(root, path.join(root, "package.json"));
  const manifestContent = fs.readFileSync(path.join(root, "package.json"), "utf8");
  let manifest: unknown;
  try { manifest = JSON.parse(manifestContent); }
  catch { throw new Error("Frontend package.json must contain valid JSON"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Frontend package.json must contain an object");
  const source = fs.existsSync(path.join(root, "src")) ? path.join(root, "src") : root;
  assertSafePath(root, source);
  if (!fs.statSync(source).isDirectory()) throw new Error("Frontend src must be a directory when present");
  const generated = path.join(source, ".fluxfast");
  return { root, source, pages: path.join(source, "flux-pages"), generated,
    registry: path.join(generated, "pages.generated.ts"), manifest: manifest as Record<string, unknown>, manifestContent };
}

/** No scaffold or generated artifact may traverse a symlink, even an internal one. */
export function assertSafePath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("FluxFast output must stay inside the frontend root");
  let current = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("FluxFast refuses to follow a scaffold or generated-output symlink");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
}

export function validatePackages(project: FrontendProject): void {
  const declarations: Record<string, unknown> = {};
  for (const section of ["dependencies", "devDependencies"]) {
    const value = project.manifest[section] ?? {};
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.values(value).some(version => typeof version !== "string" || !version.trim())) throw new Error("Package dependencies must be objects of non-empty version strings");
    Object.assign(declarations, value);
  }
  if (declarations["@fluxfast/next"]) throw new Error("Initialize a separate React/Vite frontend rather than mixing Next and Vite adapters");
  for (const name of ["@fluxfast/vite", "react", "react-dom", "vite"]) {
    if (!declarations[name]) throw new Error(`Declare and install ${name} before initializing the React/Vite frontend; no packages are downloaded by this command`);
  }
}

export function sourceViteConfig(project: FrontendProject): string | undefined {
  const candidates = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(extension => "vite.config." + extension)
    .filter(name => fs.existsSync(path.join(project.root, name)));
  if (candidates.length > 1) throw new Error("Multiple source Vite configs found; keep one authoritative vite.config file before initializing");
  if (candidates[0]) assertSafePath(project.root, path.join(project.root, candidates[0]));
  return candidates[0];
}

export function relativeFile(project: FrontendProject, target: string): string {
  return path.relative(project.root, target).replace(/\\/g, "/");
}
