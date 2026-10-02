import { buildFluxViteApp } from "./build.js";
import { createFluxViteServer } from "./server.js";
import path from "node:path";

const USAGE = `Usage:
  fluxfast-vite init [--dry-run] [--yes] [--force]
  fluxfast-vite init --check
  fluxfast-vite generate [--check] [--schema-file PATH]
  fluxfast-vite doctor
  fluxfast-vite dev [--config PATH] [--hostname HOST] [--port PORT]
  fluxfast-vite build [--config PATH]
  fluxfast-vite start [--hostname HOST] [--port PORT]
Build and serve use the configured fluxfast() Vite plugin; start reads built artifacts only.`;

export interface ViteCliIo { cwd: string; stdout(message: string): void; stderr(message: string): void }

async function runSetup(command: string, args: string[], io: ViteCliIo): Promise<number> {
  const allowed = command === "init" ? ["--dry-run", "--yes", "--force", "--check"] : command === "generate" ? ["--check", "--schema-file"] : [];
  const seen = new Set<string>();
  let schemaFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!allowed.includes(flag) || seen.has(flag)) { io.stderr(USAGE); return 2; }
    seen.add(flag);
    if (flag === "--schema-file") {
      schemaFile = args[++index];
      if (!schemaFile || schemaFile.startsWith("--")) { io.stderr(USAGE); return 2; }
    }
  }
  if (command === "init" && seen.has("--check") && args.length !== 1) { io.stderr(USAGE); return 2; }
  try {
    const { projectAt, relativeFile, validatePackages } = await import("./project.js");
    const { planSetup, applySetup, checkSetup } = await import("./setup.js");
    const { generateProject } = await import("./generation.js");
    const project = projectAt(io.cwd);
    validatePackages(project);
    if (command === "generate") {
      const result = generateProject(project, seen.has("--check"), schemaFile);
      io.stdout(result.current ? (seen.has("--check") ? "Generated FluxFast files are current." : "Generated FluxFast registry/contracts.") : "Generated FluxFast files are missing or stale; rerun generation without --check.");
      return result.current ? 0 : 1;
    }
    if (command === "doctor" || seen.has("--check")) {
      const problems = [...checkSetup(project)];
      if (!generateProject(project, true).current) problems.push("Generated FluxFast files are missing or stale");
      problems.forEach(problem => io.stderr(problem));
      if (!problems.length) io.stdout("FluxFast React/Vite setup and generated files are current. Production/runtime diagnostics remain separate.");
      return problems.length ? 1 : 0;
    }
    const plan = planSetup(project, seen.has("--force"));
    if (seen.has("--dry-run")) {
      plan.changes.forEach(change => io.stdout("Would update " + relativeFile(project, change.file)));
      io.stdout("Would generate the React registry/contracts. No files were changed.");
      return 0;
    }
    applySetup(plan);
    io.stdout("FluxFast React/Vite initialized. Existing SPA entries, configuration and scripts were preserved.");
    io.stdout("Use npm run fluxfast:dev, fluxfast:build and fluxfast:start (or the project's package manager).");
    return 0;
  } catch (error) { io.stderr(error instanceof Error ? error.message : "FluxFast setup failed"); return 1; }
}

export async function runViteCli(args: string[], io: ViteCliIo = { cwd: process.cwd(), stdout: console.log, stderr: console.error }): Promise<number> {
  if (!args.length || args.length === 1 && ["--help", "-h"].includes(args[0])) { io.stdout(USAGE); return 0; }
  const [command, ...flags] = args;
  if (["init", "generate", "doctor"].includes(command)) return runSetup(command, flags, io);
  if (!["dev", "build", "start"].includes(command)) { io.stderr(USAGE); return 2; }
  let host = "127.0.0.1";
  let port = 3000;
  let configFile: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[++index];
    const allowed = command === "build" ? ["--config"] : command === "start" ? ["--hostname", "--port"] : ["--config", "--hostname", "--port"];
    if (!allowed.includes(flag) || seen.has(flag) || !value || value.startsWith("--")) { io.stderr(USAGE); return 2; }
    seen.add(flag);
    if (flag === "--config") configFile = path.resolve(io.cwd, value);
    else if (flag === "--hostname") host = value;
    else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) port = Number(value);
    else { io.stderr(USAGE); return 2; }
  }
  try {
    if (command === "build") { await buildFluxViteApp({ root: io.cwd, configFile }); return 0; }
    const server = await createFluxViteServer({ root: io.cwd, configFile, mode: command === "start" ? "production" : "development", host, port });
    io.stdout(`FluxFast ${command === "start" ? "production" : "development"} host listening on ${server.url}`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.close().then(() => {
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); process.exitCode = 0;
      }, () => { process.exitCode = 1; });
    };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return 0;
  } catch {
    io.stderr("FluxFast host failed. Check the application, fluxfast() configuration, built artifacts, and private backend configuration.");
    return 1;
  }
}
