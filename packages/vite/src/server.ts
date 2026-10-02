import fs from "node:fs/promises";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { pathToFileURL } from "node:url";
import type { ViteDevServer } from "vite" with { "resolution-mode": "import" };
import { createFluxReactHandler, type FluxReactRender } from "@fluxfast/react/server";
import { webRequest, writeWebResponse } from "./bridge.js";
import { containedFile, createAssetHandler, readHostManifest } from "./assets.js";
import { serveHealth, healthProbe } from "./health.js";
import { BUILD_DIRECTORY, SERVER_ENTRY, configuredFluxOptions, type HostSettings } from "./options.js";

export interface FluxViteServerOptions {
  root?: string;
  configFile?: string | false;
  mode?: "development" | "production";
  host?: string;
  port?: number;
  /** Private server-only URL; defaults to supervisor-injected FLUXFAST_BACKEND_URL. */
  backendUrl?: string;
}

export interface FluxViteServer {
  /** Listening origin; ephemeral port 0 is supported for tests and embedding. */
  readonly url: string;
  /** Stop accepting requests, abort live streams and release owned sockets/watchers. */
  close(): Promise<void>;
}

function backendAddress(value: unknown): string {
  try {
    const url = new URL(typeof value === "string" ? value : "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, "");
  } catch { throw new TypeError("Set a trusted HTTP(S) backendUrl or FLUXFAST_BACKEND_URL without credentials, query, or fragment"); }
}

function rawPathIsSafe(url: string): boolean {
  try {
    const decoded = decodeURIComponent(url.split("?", 1)[0]);
    return url.startsWith("/") && !url.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(decoded) &&
      !decoded.split("/").some(segment => segment === "." || segment === "..");
  } catch { return false; }
}

/** Own one public HTTP origin. Production never imports Vite or source config. */
export async function createFluxViteServer(options: FluxViteServerOptions = {}): Promise<FluxViteServer> {
  const root = path.resolve(options.root ?? process.cwd());
  const backend = backendAddress(options.backendUrl ?? process.env.FLUXFAST_BACKEND_URL);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const production = options.mode === "production";
  if (options.mode !== undefined && options.mode !== "production" && options.mode !== "development") throw new TypeError("Invalid FluxFast server mode");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("FluxFast port must be an integer from 0 to 65535");
  if (production && options.configFile !== undefined) throw new TypeError("Production reads built artifacts, not a source configFile");
  let stopping = false;
  let vite: ViteDevServer | undefined;
  let document: (request: Request) => Promise<Response>;
  let assets: (request: Request) => Promise<Response | undefined> = async () => undefined;
  const controllers = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const http = createServer((incoming, outgoing) => { void serve(incoming, outgoing); });
  http.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });

  async function serve(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    const disconnect = () => { if (!outgoing.writableEnded) abort(); };
    const destroy = () => outgoing.destroy();
    incoming.once("aborted", abort);
    outgoing.once("close", disconnect);
    controller.signal.addEventListener("abort", destroy, { once: true });
    try {
      if (!rawPathIsSafe(incoming.url ?? "/")) {
        await writeWebResponse(new Response(null, { status: 400 }), outgoing, controller.signal);
        return;
      }
      const request = webRequest(incoming, controller.signal);
      if (healthProbe(request)) {
        await writeWebResponse(await serveHealth(request, backend, stopping), outgoing, controller.signal);
        return;
      }
      if (stopping) { await writeWebResponse(new Response(null, { status: 503 }), outgoing, controller.signal); return; }
      // Protocol traffic always precedes Vite/static middleware: no path,
      // extension, cookie, body or live stream is reinterpreted as an asset.
      if (request.headers.get("x-fluxfast") !== "1") {
        if (vite) {
          const handled = await new Promise<boolean>((resolve, reject) => {
            const finish = () => { cleanup(); resolve(true); };
            const cleanup = () => { outgoing.removeListener("finish", finish); outgoing.removeListener("close", finish); };
            outgoing.once("finish", finish); outgoing.once("close", finish);
            vite!.middlewares(incoming, outgoing, (error?: unknown) => { cleanup(); if (error) reject(error); else resolve(false); });
          });
          if (handled) return;
        } else {
          const asset = await assets(request);
          if (asset) { await writeWebResponse(asset, outgoing, controller.signal); return; }
        }
      }
      await writeWebResponse(await document(request), outgoing, controller.signal);
    } catch {
      if (outgoing.headersSent || controller.signal.aborted) outgoing.destroy();
      else { outgoing.writeHead(500, { "content-type": "text/plain", "cache-control": "no-store" }); outgoing.end("Page unavailable"); }
    } finally {
      incoming.removeListener("aborted", abort);
      outgoing.removeListener("close", disconnect);
      controller.signal.removeEventListener("abort", destroy);
      controllers.delete(controller);
    }
  }

  try {
    if (production) {
      const output = path.join(root, BUILD_DIRECTORY);
      const manifest = readHostManifest(JSON.parse(await fs.readFile(path.join(output, "host.json"), "utf8")));
      const client = path.join(output, "client");
      const template = await fs.readFile(await containedFile(client, manifest.template), "utf8");
      const rendererFile = await containedFile(path.join(output, "server"), "renderer.mjs");
      const renderer = await import(pathToFileURL(rendererFile).href) as { render: FluxReactRender; settings: HostSettings };
      if (typeof renderer.render !== "function") throw new Error("Invalid FluxFast production renderer");
      document = createFluxReactHandler({ ...renderer.settings, backendUrl: backend, render: renderer.render, template, development: false });
      assets = createAssetHandler(client, manifest.assets, manifest.template);
    } else {
      const { createServer: createViteServer } = await import("vite");
      vite = await createViteServer({
        root, ...(options.configFile === undefined ? {} : { configFile: options.configFile }), appType: "custom",
        server: { middlewareMode: true, hmr: { server: http }, host, port, strictPort: true },
      });
      configuredFluxOptions(vite.config);
      const renderer = await vite.ssrLoadModule(SERVER_ENTRY);
      if (typeof renderer.render !== "function") throw new Error("Invalid FluxFast development renderer");
      document = request => {
        const configured = configuredFluxOptions(vite!.config);
        const handler = createFluxReactHandler({
          ...configured.settings, backendUrl: backend, development: configured.diagnostics,
          render: async (props, renderOptions) => (await vite!.ssrLoadModule(SERVER_ENTRY)).render(props, renderOptions),
          template: async input => vite!.transformIndexHtml(new URL(input.url).pathname, await fs.readFile(configured.template, "utf8")),
        });
        return handler(request);
      };
    }
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { http.removeListener("listening", ready); reject(error); };
      const ready = () => { http.removeListener("error", failed); resolve(); };
      http.once("error", failed); http.once("listening", ready); http.listen(port, host);
    });
  } catch (error) {
    await vite?.close();
    for (const socket of sockets) socket.destroy();
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("FluxFast server did not bind a TCP port");
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    close() {
      return closing ??= (async () => {
        stopping = true;
        const closed = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        for (const controller of controllers) controller.abort();
        await vite?.close();
        for (const socket of sockets) socket.destroy();
        await closed;
      })();
    },
  };
}
