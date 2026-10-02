/** Exercise the Python supervisor using only installed React/Vite release artifacts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProcessHarness } from "../tests/adapter-conformance/process-harness.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-react-supervision-"));
const frontend = path.join(temporary, "app", "frontend with spaces");
const application = path.dirname(frontend);
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";
const pnpm = windows ? "pnpm.cmd" : "pnpm";
const localPython = path.join(repository, ".venv", windows ? "Scripts/python.exe" : "bin/python");
const bootstrap = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
const configuredArtifacts = process.env.FLUXFAST_TYPES_ARTIFACT_DIR;
const artifacts = configuredArtifacts ? path.resolve(configuredArtifacts) : path.join(temporary, "artifacts");
const tooling = createRequire(path.join(repository, "packages/vite/package.json"));

function environment() {
  const result = { ...process.env, PYTHONPATH: "", npm_config_update_notifier: "false" };
  for (const name of Object.keys(result)) {
    if (/verify_deps_before_run|link_workspace_packages|@jsr:registry/i.test(name)) delete result[name];
  }
  delete result.NODE_ENV;
  delete result.FLUXFAST_BACKEND_URL;
  delete result.FLUXFAST_PRODUCTION_START;
  result.NEXT_PUBLIC_FLUXFAST_BACKEND_URL = "https://must-not-reach-the-browser.invalid";
  return result;
}
function run(command, args, cwd = application) {
  const result = spawnSync(command, args, {
    cwd, env: environment(), encoding: "utf8", timeout: 180_000,
    shell: windows && (command === npm || command === pnpm),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}
function one(directory, prefix, suffix) {
  const matches = fs.readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith(suffix));
  assert.equal(matches.length, 1, `Expected one ${prefix}*${suffix}`);
  return path.join(directory, matches[0]);
}
function snapshot() {
  const records = {};
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === "node_modules") continue;
      const file = path.join(directory, name), key = path.join(relative, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, key);
      else {
        assert.ok(stat.isFile(), "Unexpected consumer symlink: " + key);
        records[key] = { mode: stat.mode, mtime: stat.mtimeMs, hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
      }
    }
  }
  visit(frontend);
  return records;
}
async function ports() {
  const servers = [net.createServer(), net.createServer()];
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    })));
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve()));
  }
}
async function verifyService(fluxfast, mode) {
  const [publicPort, backendPort] = await ports();
  const baseUrl = `http://127.0.0.1:${publicPort}`;
  const args = [mode, "backend:app", "--frontend", frontend, "--backend-port", String(backendPort), "--startup-timeout", "60"];
  args.push(...(mode === "dev" ? ["--frontend-host", "127.0.0.1", "--frontend-port", String(publicPort), "--no-reload"] : ["--host", "127.0.0.1", "--port", String(publicPort), "--shutdown-timeout", "10"]));
  const host = createProcessHarness({
    name: "installed React Python " + mode, baseUrl, readyUrl: baseUrl + "/fluxfast/readyz",
    command: fluxfast, args, cwd: application, env: environment(), additionalPorts: [backendPort],
    readinessTimeout: 90_000, shutdownTimeout: 20_000,
    requireZeroExit: true,
  });
  const before = snapshot();
  try {
    await host.start();
    const page = await fetch(baseUrl, { signal: AbortSignal.timeout(20_000) });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<h1>Hello from FastAPI<\/h1>/);
    for (const secret of [String(backendPort), "FLUXFAST_BACKEND_URL", "must-not-reach-the-browser", "Next.js"]) assert.equal(html.includes(secret), false);
    const protocol = await fetch(baseUrl, { headers: { "x-fluxfast": "1", "x-fluxfast-protocol": "1" }, signal: AbortSignal.timeout(10_000) });
    assert.equal(protocol.status, 200);
    const envelope = await protocol.json();
    assert.equal(envelope.page.component, "home/index");
    assert.equal(envelope.resources.greeting.value, "Hello from FastAPI");
    for (const [name, expected] of [["healthz", "ok"], ["readyz", "ready"]]) {
      const response = await fetch(baseUrl + "/fluxfast/" + name, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: expected });
    }
    const missing = await fetch(baseUrl + "/missing", { signal: AbortSignal.timeout(10_000) });
    assert.equal(missing.status, 404); await missing.body?.cancel();
    const script = /<script[^>]+src="([^"]+)"/.exec(html);
    assert.ok(script, "SSR must include a hydration entry");
    const asset = await fetch(new URL(script[1], baseUrl), { signal: AbortSignal.timeout(10_000) });
    assert.equal(asset.status, 200); await asset.body?.cancel();
    if (mode === "start") {
      for (const name of ["/fluxfast.html", "/dist/fluxfast/server/renderer.mjs", "/src/flux-pages/home/index.jsx"]) {
        const response = await fetch(baseUrl + name, { signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 404); await response.body?.cancel();
      }
    }
  } finally { await host.stop(); }
  assert.deepEqual(snapshot(), before, mode + " modified frontend inputs or built artifacts");
  console.log(`Installed Python ${mode}: one-origin SSR, protocol, assets, health, 404, unchanged inputs and both ports released`);
}

try {
  assert.ok(path.relative(repository, temporary).startsWith(".." + path.sep), "Consumer must be outside the source checkout");
  fs.mkdirSync(frontend, { recursive: true });
  const virtualenv = path.join(temporary, "python");
  run(bootstrap, ["-m", "venv", virtualenv]);
  const python = path.join(virtualenv, windows ? "Scripts/python.exe" : "bin/python");
  const fluxfast = path.join(virtualenv, windows ? "Scripts/fluxfast.exe" : "bin/fluxfast");
  if (!configuredArtifacts) {
    fs.mkdirSync(path.join(artifacts, "npm"), { recursive: true }); fs.mkdirSync(path.join(artifacts, "python"));
    for (const owner of ["core", "codegen", "react", "vite"]) {
      run(pnpm, ["--filter", "@fluxfast/" + owner, "run", "build"], repository);
      run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", path.join(artifacts, "npm")], path.join(repository, "packages", owner));
    }
    run(python, ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", path.join(artifacts, "python"), path.join(repository, "python/fluxfast")]);
  }
  const versions = Object.fromEntries(["react", "react-dom", "vite"].map(name => [name, JSON.parse(fs.readFileSync(tooling.resolve(name + "/package.json"), "utf8")).version]));
  const hostVersion = JSON.parse(fs.readFileSync(path.join(repository, "packages/vite/package.json"), "utf8")).version;
  fs.writeFileSync(path.join(frontend, "package.json"), JSON.stringify({ private: true, dependencies: { "@fluxfast/vite": hostVersion, ...versions }, scripts: { dev: "node -e 'throw Error()'", build: "node -e 'throw Error()'", start: "node -e 'throw Error()'" } }));
  fs.writeFileSync(path.join(frontend, "index.html"), "<h1>Existing SPA is preserved</h1>\n");
  fs.writeFileSync(path.join(frontend, "vite.config.mjs"), "export default { define: { __EXISTING_CONFIG__: 'true' } };\n");
  fs.mkdirSync(path.join(frontend, "src/flux-pages/home"), { recursive: true });
  fs.writeFileSync(path.join(frontend, "src/flux-pages/home/index.jsx"), 'import { useResource } from "@fluxfast/react";\nexport default function Home() { const greeting = useResource("greeting"); return <main><h1>{greeting}</h1></main>; }\n');
  const spaBefore = fs.readFileSync(path.join(frontend, "index.html"));
  const configBefore = fs.readFileSync(path.join(frontend, "vite.config.mjs"));
  run(npm, ["install", ...["core", "codegen", "react", "vite"].map(owner => one(path.join(artifacts, "npm"), "fluxfast-" + owner + "-", ".tgz")), "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--no-package-lock"], frontend);
  for (const name of ["next", "@fluxfast/next"]) assert.equal(fs.existsSync(path.join(frontend, "node_modules", name)), false);
  run(python, ["-m", "pip", "install", "--quiet", one(path.join(artifacts, "python"), "fluxfast-", ".whl")]);
  run(python, ["-c", "import fluxfast,sys; from pathlib import Path; assert Path(fluxfast.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())"]);
  fs.writeFileSync(path.join(application, "backend.py"), `from fastapi import FastAPI
from fluxfast import FluxFast, Page, resource
app = FastAPI()
flux = FluxFast(app)
GREETING = flux.define_resource("greeting", str)
@flux.page("/")
async def home() -> Page:
    return Page(component="home/index", resources=[resource(GREETING, lambda: "Hello from FastAPI")])
`);
  run(npm, ["exec", "--no", "--", "fluxfast-vite", "init"], frontend);
  run(fluxfast, ["types", "backend:app", "--frontend", frontend]);
  run(fluxfast, ["types", "backend:app", "--frontend", frontend, "--check"]);
  assert.deepEqual(fs.readFileSync(path.join(frontend, "index.html")), spaBefore);
  assert.deepEqual(fs.readFileSync(path.join(frontend, "vite.config.mjs")), configBefore);
  await verifyService(fluxfast, "dev");
  run(fluxfast, ["build", "--app", "backend:app", "--frontend", frontend]);
  const built = snapshot();
  const doctor = run(fluxfast, ["doctor", "--production", "--app", "backend:app", "--frontend", frontend, "--strict"]);
  assert.match(doctor, /React\/Vite adapter is initialized/);
  assert.match(doctor, /Production configuration looks ready/);
  assert.deepEqual(snapshot(), built, "Doctor must be read-only");
  const manifest = JSON.parse(fs.readFileSync(path.join(frontend, "dist/fluxfast/host.json"), "utf8"));
  for (const name of manifest.assets.filter(name => /\.m?js$/.test(name))) {
    const source = fs.readFileSync(path.join(frontend, "dist/fluxfast/client", name), "utf8");
    const forbidden = /@fluxfast\/(?:next|codegen)|FLUXFAST_BACKEND_URL|FLUXFAST_PRODUCTION_START|["']node:/.exec(source);
    assert.equal(forbidden, null, `Forbidden client marker in ${name}: ${forbidden ? source.slice(Math.max(0, forbidden.index - 60), forbidden.index + 100) : "none"}`);
  }
  // Remove only this test's owned temporary inputs/tooling. Production must boot
  // from renderer/client output, not silently generate or evaluate source config.
  for (const name of ["src", "fluxfast.html", "fluxfast.vite.config.mjs", "vite.config.mjs", "index.html", "node_modules/vite", "node_modules/@fluxfast/codegen"]) fs.rmSync(path.join(frontend, name), { recursive: true, force: true });
  await verifyService(fluxfast, "start");
  console.log("Packed React/Vite Python supervision passes without Next; production also passes without source, Vite or Codegen.");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
