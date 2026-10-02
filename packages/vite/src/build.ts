import fs from "node:fs/promises";
import path from "node:path";
import { BUILD_DIRECTORY, SERVER_ENTRY, configuredFluxOptions, safeAssetName, type FluxViteBuildOptions } from "./options.js";

/** Produce separate client assets and a Node renderer; never contact FastAPI. */
export async function buildFluxViteApp(options: FluxViteBuildOptions = {}): Promise<void> {
  if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== "production") {
    throw new Error("FluxFast production builds require NODE_ENV=production (or unset)");
  }
  const vite = await import("vite");
  const root = path.resolve(options.root ?? process.cwd());
  const common = { root, ...(options.configFile === undefined ? {} : { configFile: options.configFile }), mode: "production" };
  const config = await vite.resolveConfig(common, "build");
  const flux = configuredFluxOptions(config);
  const output = path.join(config.root, BUILD_DIRECTORY);
  const templateSource = await fs.readFile(flux.template, "utf8");
  for (const marker of ["<!--fluxfast:ssr-->", "<!--fluxfast:payload-->"]) {
    if (templateSource.split(marker).length !== 2) throw new Error("FluxFast template requires exactly one SSR and payload marker");
  }
  // Reject output symlinks before either build can clear a directory.
  for (const name of ["dist", BUILD_DIRECTORY, BUILD_DIRECTORY + "/client", BUILD_DIRECTORY + "/server"]) {
    try {
      const stat = await fs.lstat(path.join(config.root, name));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("FluxFast build output must use regular, non-symlinked directories");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await fs.unlink(path.join(output, "host.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
  // Fixed, owned leaf directories only. Never clear an arbitrary config outDir.
  await vite.build({ ...common, build: {
    outDir: path.join(output, "client"), emptyOutDir: true, sourcemap: false,
    rollupOptions: { input: flux.template },
  } });
  await vite.build({ ...common, build: {
    ssr: true, outDir: path.join(output, "server"), emptyOutDir: true,
    sourcemap: false, copyPublicDir: false,
    rollupOptions: { input: SERVER_ENTRY, output: { format: "es", entryFileNames: "renderer.mjs", chunkFileNames: "chunks/[name]-[hash].mjs" } },
  } });
  const client = path.join(output, "client");
  const template = path.relative(config.root, flux.template).replace(/\\/g, "/");
  // Vite emits the HTML at its relative input path. Record exactly what built,
  // rather than evaluating configuration again during production startup.
  await fs.access(path.join(client, template));
  const assets: string[] = [];
  async function scan(directory: string, prefix = ""): Promise<void> {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isDirectory() && !item.name.startsWith(".")) await scan(path.join(directory, item.name), name + "/");
      else if (item.isFile() && safeAssetName(name)) assets.push(name);
    }
  }
  await scan(client);
  await fs.writeFile(path.join(output, "host.json"), JSON.stringify({ version: 1, template, assets: assets.sort() }) + "\n");
}
