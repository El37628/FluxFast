import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as nodeRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFluxViteApp as buildDirect } from "../src/build";
import { createFluxViteServer, type FluxViteServer } from "../src/server";
import { readHostManifest, createAssetHandler } from "../src/assets";
import { resolveOptions } from "../src/options";

const packageRoot = path.resolve(__dirname, "..");
const pluginUrl = pathToFileURL(path.join(packageRoot, "dist/esm/index.js")).href;
const template = '<!doctype html><html><body><div id="fluxfast-root"><!--fluxfast:ssr--></div><!--fluxfast:payload--><script type="module" src="/@fluxfast/client"></script></body></html>';

// Build in a separate production process: Vitest's NODE_ENV=test must not turn
// the production browser dependency conditions into development exports.
async function buildFluxViteApp({ root }: { root: string }): Promise<void> {
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `const {buildFluxViteApp}=await import(${JSON.stringify(pluginUrl)}); await buildFluxViteApp({root:${JSON.stringify(root)}});`],
    { cwd: root, env: { ...process.env, NODE_ENV: "production" }, timeout: 20_000 });
}

describe("real Vite development and built production hosts", () => {
  let root: string;
  let backendUrl: string;
  let service: FluxViteServer | undefined;
  let requests: { url: string; headers: IncomingMessage["headers"]; method: string; body: string }[];
  let backend: ReturnType<typeof createServer>;
  let extraBackend: ReturnType<typeof createServer> | undefined;
  let liveClosed: Promise<void>;
  let resolveLiveClosed: () => void;

  beforeEach(async () => {
    service = undefined;
    extraBackend = undefined;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-vite-host-"));
    fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","private":true}');
    fs.writeFileSync(path.join(root, "vite.config.mjs"), `import { fluxfast } from ${JSON.stringify(pluginUrl)}; export default {plugins:[fluxfast({application:"src/application.tsx",forwardHeaders:["x-tenant"], diagnostics:true})],logLevel:"silent"};`);
    fs.writeFileSync(path.join(root, "fluxfast.html"), template);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/application.tsx"), `
      import {FluxRoot} from "@fluxfast/react";
      const registry = {"home/index":{load:()=>import("./page")}};
      export function FluxApplication(props) {return <FluxRoot {...props} registry={registry}/>;}
    `);
    fs.writeFileSync(path.join(root, "src/page.tsx"), `import {useResource} from "@fluxfast/react"; import "./page.css"; export default function Page() {return <h1>{useResource("greeting")}</h1>;}`);
    fs.writeFileSync(path.join(root, "src/page.css"), "h1{color:green}");
    requests = [];
    liveClosed = new Promise(resolve => { resolveLiveClosed = resolve; });
    backend = createServer((request, response) => { void backendRequest(request, response); });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address();
    if (!address || typeof address === "string") throw new Error("Backend did not listen");
    backendUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await service?.close();
    await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections(); });
    if (extraBackend) await new Promise<void>(resolve => { extraBackend!.close(() => resolve()); extraBackend!.closeAllConnections(); });
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function backendRequest(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push({ url: request.url!, headers: request.headers, method: request.method!, body });
    if (request.url?.startsWith("/_fluxfast/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: request.url.endsWith("readyz") ? "ready" : "ok", privateUrl: backendUrl }));
      return;
    }
    if (request.url === "/live") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write("event: ready\ndata: {}\n\n");
      response.once("close", resolveLiveClosed);
      return;
    }
    if (request.url === "/mutation") {
      response.writeHead(422, { "content-type": "application/json", "set-cookie": ["one=1; Path=/", "two=2; Path=/"], "x-fluxfast-devtools-trace": "private-trace" });
      response.end(JSON.stringify({ body, authorized: request.headers.cookie === "session=user" }));
      return;
    }
    if (request.url === "/external") { response.writeHead(302, { location: "https://other.invalid/private" }); response.end(); return; }
    if (request.url === "/canonical") { response.writeHead(302, { location: "/?tag=one&tag=two" }); response.end(); return; }
    const status = request.url === "/missing" ? 404 : request.url === "/denied" ? 403 : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200 ? {
      protocol: "fluxfast/1", page: { component: "home/index", url: request.url }, resourceKeys: ["greeting"],
      resources: { greeting: { value: request.headers.cookie === "session=user" ? "Authenticated SSR" : "Actual SSR", version: "v1" } },
    } : { detail: "private backend failure " + backendUrl }));
  }

  it.each(["development", "production"] as const)("renders meaningful HTML and same-origin protocol traffic in %s", async mode => {
    if (mode === "production") await buildFluxViteApp({ root });
    service = await createFluxViteServer({ root, backendUrl, mode, port: 0 });
    const document = await fetch(service.url + "/?tag=one&tag=two", { headers: { cookie: "session=user", authorization: "Bearer test", "x-tenant": "workspace" } });
    const html = await document.text();
    expect(document.status).toBe(200);
    expect(document.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("<h1>Authenticated SSR</h1>");
    const props = JSON.parse(html.split('<script id="fluxfast-page" type="application/json">')[1].split("</script>")[0]);
    expect(props.initialEnvelope.resources.greeting).toEqual({ value: "Authenticated SSR", version: "v1" });
    expect(html).not.toContain(backendUrl);
    expect(requests[0]).toMatchObject({ url: "/?tag=one&tag=two", method: "GET", headers: { "x-fluxfast": "1", cookie: "session=user", authorization: "Bearer test", "x-tenant": "workspace" } });
    const health = await fetch(service.url + "/fluxfast/readyz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ready" });
    const mutation = await fetch(service.url + "/mutation", { method: "POST", headers: { "x-fluxfast": "1", cookie: "session=user", "content-type": "application/json", "x-fluxfast-devtools": "1" }, body: '{"name":"test"}' });
    expect(mutation.status).toBe(422);
    expect(mutation.headers.getSetCookie()).toEqual(["one=1; Path=/", "two=2; Path=/"]);
    expect(await mutation.json()).toEqual({ body: '{"name":"test"}', authorized: true });
    if (mode === "production") expect(mutation.headers.has("x-fluxfast-devtools-trace")).toBe(false);
    for (const [route, status] of [["/missing", 404], ["/denied", 403], ["/external", 500]] as const) {
      const result = await fetch(service.url + route);
      expect(result.status).toBe(status);
      expect(await result.text()).not.toContain(backendUrl);
    }
    const canonical = await fetch(service.url + "/canonical");
    expect(canonical.status).toBe(200);
    expect(await canonical.text()).toContain("Actual SSR");
    const controller = new AbortController();
    const live = await fetch(service.url + "/live", { headers: { "x-fluxfast": "1" }, signal: controller.signal });
    const chunk = await live.body!.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toContain("event: ready");
    controller.abort();
    await liveClosed;
    if (mode === "development") {
      expect(html).toContain("/@vite/client");
      const client = await fetch(service.url + "/@fluxfast/client");
      expect(await client.text()).toContain("hydrateFluxApplication");
    } else {
      expect(html).not.toContain("/@vite/client");
      const javascript = html.match(/src="([^"]+\.js)"/)?.[1];
      expect(javascript).toBeTruthy();
      const asset = await fetch(service.url + javascript);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
      expect(await asset.text()).not.toContain(backendUrl);
      for (const route of ["/fluxfast.html", "/assets/missing.js", "/dist/fluxfast/server/renderer.mjs", "/src/page.tsx", "/@fluxfast/client", "/.env", "/assets/source.js.map"]) {
        expect((await fetch(service.url + route)).status).toBe(404);
      }
      // A document extension is not a second frontend routing authority.
      expect((await fetch(service.url + "/application-page.html")).status).toBe(200);
    }
  }, 30_000);

  it("production boots with only build outputs after source/config are removed and never imports Vite", async () => {
    await buildFluxViteApp({ root });
    const before = fs.readFileSync(path.join(root, "dist/fluxfast/host.json"), "utf8");
    fs.rmSync(path.join(root, "src"), { recursive: true });
    fs.rmSync(path.join(root, "fluxfast.html"));
    fs.writeFileSync(path.join(root, "vite.config.mjs"), 'throw new Error("Source config must not execute in production");');
    service = await createFluxViteServer({ root, backendUrl, mode: "production", port: 0 });
    expect(await (await fetch(service.url)).text()).toContain("Actual SSR");
    expect(fs.readFileSync(path.join(root, "dist/fluxfast/host.json"), "utf8")).toBe(before);
  }, 30_000);

  it("graceful close cancels active SSE and releases its public listening port idempotently", async () => {
    service = await createFluxViteServer({ root, backendUrl, port: 0 });
    const live = await fetch(service.url + "/live", { headers: { "x-fluxfast": "1" } });
    await live.body!.getReader().read();
    const closing = service.close();
    expect(service.close()).toBe(closing);
    await closing;
    await liveClosed;
    await expect(fetch(service.url)).rejects.toThrow();
  }, 15_000);

  it("development HMR connects through the same public HTTP port", async () => {
    service = await createFluxViteServer({ root, backendUrl, port: 0 });
    const client = await (await fetch(service.url + "/@vite/client")).text();
    const token = client.match(/const wsToken = "([^"]+)"/)?.[1];
    expect(token).toBeTruthy();
    const socket = new WebSocket(service.url.replace("http:", "ws:") + "/?token=" + token, "vite-hmr");
    try {
      const connected = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("HMR did not connect on the public port")), 3_000);
        socket.addEventListener("message", event => { clearTimeout(timer); resolve(JSON.parse(String(event.data))); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("HMR connection failed")); }, { once: true });
      });
      expect(connected).toMatchObject({ type: "connected" });
    } finally { socket.close(); }
  }, 15_000);

  it("preserves multiple Cookie fields with semicolon rather than comma joining", async () => {
    service = await createFluxViteServer({ root, backendUrl, port: 0 });
    const url = new URL(service.url);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      let data = "";
      socket.once("connect", () => socket.write("GET / HTTP/1.1\r\nHost: " + url.host + "\r\nCookie: session=user\r\nCookie: theme=dark\r\nConnection: close\r\n\r\n"));
      socket.on("data", chunk => { data += chunk.toString(); });
      socket.once("end", () => resolve(data)); socket.once("error", reject);
    });
    expect(response).toContain("HTTP/1.1 200");
    expect(requests[0].headers.cookie).toBe("session=user; theme=dark");
  }, 15_000);

  it("two host instances do not share or mutate private backend configuration", async () => {
    await buildFluxViteApp({ root });
    service = await createFluxViteServer({ root, backendUrl, mode: "production", port: 0 });
    extraBackend = createServer((_, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ protocol: "fluxfast/1", page: { component: "home/index", url: "/" }, resourceKeys: ["greeting"], resources: { greeting: { value: "Other backend", version: "v2" } } })); });
    await new Promise<void>(resolve => extraBackend!.listen(0, "127.0.0.1", resolve));
    const address = extraBackend.address();
    if (!address || typeof address === "string") throw new Error("Second backend did not listen");
    const environment = process.env.FLUXFAST_BACKEND_URL;
    const other = await createFluxViteServer({ root, backendUrl: `http://127.0.0.1:${address.port}`, mode: "production", port: 0 });
    try {
      const results = await Promise.all([fetch(service.url).then(r => r.text()), fetch(other.url).then(r => r.text())]);
      expect(results[0]).toContain("Actual SSR");
      expect(results[0]).not.toContain("Other backend");
      expect(results[1]).toContain("Other backend");
      expect(process.env.FLUXFAST_BACKEND_URL).toBe(environment);
    } finally { await other.close(); }
  }, 30_000);

  it("rejects missing production output instead of building, evaluating config, or binding a port", async () => {
    const files = fs.readdirSync(root);
    await expect(createFluxViteServer({ root, backendUrl, mode: "production", port: 0 })).rejects.toThrow();
    expect(fs.readdirSync(root)).toEqual(files);
  });

  it.each(["/assets/%2e%2e/private", "/bad%2f..%2fsecret", "/bad%ZZ", "/bad%00", "/bad%5csecret"])("rejects raw unsafe paths before normalization (%s)", async route => {
    service = await createFluxViteServer({ root, backendUrl, port: 0 });
    const status = await new Promise<number>(resolve => {
      const outgoing = nodeRequest(service!.url, { path: route }, response => { response.resume(); resolve(response.statusCode!); });
      outgoing.end();
    });
    expect(status).toBe(400);
    expect(requests).toEqual([]);
  }, 15_000);

  it("rejects an output-directory symlink without clearing its target", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-vite-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "sentinel"), "user-owned");
      fs.symlinkSync(outside, path.join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
      await expect(buildFluxViteApp({ root })).rejects.toThrow("non-symlinked");
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("user-owned");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it("rejects a non-root Vite base instead of silently overriding application configuration", async () => {
    fs.writeFileSync(path.join(root, "vite.config.mjs"), `import {fluxfast} from ${JSON.stringify(pluginUrl)}; export default {base:"/other/",plugins:[fluxfast()]};`);
    await expect(buildFluxViteApp({ root })).rejects.toThrow("requires base '/'");
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });
});

describe("configuration and asset admission", () => {
  it("does not silently build development dependencies as production output", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    await expect(buildDirect()).rejects.toThrow("NODE_ENV=production");
  });
  it.each(["https://user:secret@backend.invalid", "file:///secret", "http://backend.invalid/?token=secret", "not-a-url"])("rejects private configuration without reflecting it (%s)", async backendUrl => {
    await expect(createFluxViteServer({ backendUrl })).rejects.toThrow("trusted HTTP(S)");
  });
  it.each(["../private.html", "/outside.html", "template.txt"])("rejects a template outside the owned HTML input (%s)", template => {
    expect(() => resolveOptions("/project", { template })).toThrow("HTML file inside");
  });
  it.each([{ cache: { maxPages: 0 } }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { forwardHeaders: "authorization" }])("validates shared runtime configuration before any build or bind", options => {
    expect(() => resolveOptions("/project", options as never)).toThrow();
  });
  it.each([
    { version: 2, template: "fluxfast.html", assets: [] },
    { version: 1, template: "../private.html", assets: [] },
    { version: 1, template: "fluxfast.html", assets: ["../renderer.mjs"] },
    { version: 1, template: "fluxfast.html", assets: [".env"] },
    { version: 1, template: "fluxfast.html", assets: ["assets/x.js", "assets/x.js"] },
  ])("rejects malformed production metadata", value => expect(() => readHostManifest(value)).toThrow("production manifest"));
  it("refuses a known asset symlink outside its client directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-vite-assets-"));
    try {
      fs.mkdirSync(path.join(root, "client"));
      fs.writeFileSync(path.join(root, "secret"), "private");
      fs.symlinkSync(path.join(root, "secret"), path.join(root, "client/leak.js"));
      const result = await createAssetHandler(path.join(root, "client"), ["leak.js"])(new Request("http://public.invalid/leak.js"));
      expect(result!.status).toBe(404);
      expect(await result!.text()).not.toContain("private");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
