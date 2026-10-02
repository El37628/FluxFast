import { buildFluxViteApp } from "./build.js";
import { createFluxViteServer } from "./server.js";

const USAGE = "Usage: fluxfast-vite <dev|build|start> [--hostname HOST] [--port PORT]\nBuild and serve use the configured fluxfast() Vite plugin; start reads built artifacts only.";

export async function runViteCli(args: string[]): Promise<number> {
  if (!args.length || args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(USAGE); return 0; }
  const [command, ...flags] = args;
  if (!["dev", "build", "start"].includes(command)) { console.error(USAGE); return 2; }
  let host = "127.0.0.1";
  let port = 3000;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[++index];
    if (command === "build" || !["--hostname", "--port"].includes(flag) || seen.has(flag) || !value || value.startsWith("--")) { console.error(USAGE); return 2; }
    seen.add(flag);
    if (flag === "--hostname") host = value;
    else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) port = Number(value);
    else { console.error(USAGE); return 2; }
  }
  try {
    if (command === "build") { await buildFluxViteApp(); return 0; }
    const server = await createFluxViteServer({ mode: command === "start" ? "production" : "development", host, port });
    console.log(`FluxFast ${command === "start" ? "production" : "development"} host listening on ${server.url}`);
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
    console.error("FluxFast host failed. Check the application, fluxfast() configuration, built artifacts, and private backend configuration.");
    return 1;
  }
}
