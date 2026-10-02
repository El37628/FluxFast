/** Run unchanged browser contracts against initialized, installed release artifacts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createReactHarness } from "../tests/adapter-conformance/harnesses/react.mjs";
import { prepareReactFixture } from "../tests/adapter-conformance/react-fixture.mjs";
import { REACT_RELEASE_PACKAGES, resolveReactPublishedConfig, waitForReactPublication } from "./react-published-config.mjs";

const published = resolveReactPublishedConfig({ version: process.env.FLUXFAST_PUBLISHED_VERSION,
  artifactDirectory: process.env.FLUXFAST_TYPES_ARTIFACT_DIR, attempts: process.env.FLUXFAST_REGISTRY_PROPAGATION_ATTEMPTS });

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-react-browser-"));
const frontend = path.join(temporary, "frontend with spaces");
const fixture = path.join(repository, "tests/browser/react-frontend");
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm", pnpm = windows ? "pnpm.cmd" : "pnpm";
const require = createRequire(path.join(repository, "tests/browser/frontend/package.json"));
const { chromium } = require("@playwright/test");
const localPython = path.join(repository, ".venv", windows ? "Scripts/python.exe" : "bin/python");
const bootstrap = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
const configuredArtifacts = process.env.FLUXFAST_TYPES_ARTIFACT_DIR;
const artifacts = configuredArtifacts ? path.resolve(configuredArtifacts) : path.join(temporary, "artifacts");
const env = { ...process.env, PYTHONPATH: temporary, npm_config_update_notifier: "false" };
for (const name of Object.keys(env)) {
  if (/verify_deps_before_run|link_workspace_packages|@jsr:registry/i.test(name)) delete env[name];
}
for (const name of ["NODE_ENV", "FLUXFAST_BACKEND_URL", "FLUXFAST_PRODUCTION_START"]) delete env[name];
env.NEXT_PUBLIC_FLUXFAST_BACKEND_URL = "https://must-not-reach-the-browser.invalid";

function run(command, args, cwd = temporary, environment = env) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: "inherit", timeout: 600_000,
    shell: windows && (command === npm || command === pnpm) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${path.basename(command)} exited ${result.status ?? result.signal}`);
}
function one(directory, prefix, suffix) {
  const names = fs.readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith(suffix));
  assert.equal(names.length, 1, `Expected one ${prefix}*${suffix}`);
  return path.join(directory, names[0]);
}
function snapshot() {
  const records = {};
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      if (["node_modules", "test-results", "playwright-report"].includes(name)) continue;
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
async function coldHydrationAndReload(python) {
  const [port, backendPort] = await ports();
  const variables = { FLUXFAST_CONFORMANCE_ROOT: temporary, FLUXFAST_REACT_FRONTEND_ROOT: frontend,
    FLUXFAST_E2E_PYTHON: python, FLUXFAST_E2E_PORT: String(port), FLUXFAST_E2E_BACKEND_PORT: String(backendPort),
    FLUXFAST_E2E_PRODUCTION: "0", PYTHONPATH: temporary };
  const saved = Object.fromEntries(Object.keys(variables).map(name => [name, process.env[name]]));
  Object.assign(process.env, variables);
  const host = createReactHarness();
  let browser;
  try {
    browser = await chromium.launch();
    await host.start();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => { window.fluxConformanceEnabled = true; });
    let documents = 0;
    const loads = [], errors = [], origins = new Set(), socketOrigins = new Set();
    page.on("websocket", socket => {
      const url = new URL(socket.url());
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      socketOrigins.add(url.origin);
    });
    page.on("request", request => {
      origins.add(new URL(request.url()).origin);
      if (request.resourceType() === "document") documents += 1;
      if (request.headers()["x-fluxfast"] === "1") loads.push(request.url());
    });
    page.on("pageerror", error => errors.push(error.message));
    const response = await page.goto(host.baseUrl + "/contract/0?run=cold-" + Date.now());
    assert.equal(response.status(), 200);
    const initialHtml = await response.text();
    const expected = JSON.parse(initialHtml.split('<script id="fluxfast-page" type="application/json">')[1].split("</script>")[0]).initialEnvelope;
    await page.waitForFunction(() => document.querySelector('[data-testid="contract-page"]')?.getAttribute("data-hydrated") === "true" && window.fluxAdapterConformance);
    await delay(750);
    assert.equal(documents, 1, "Cold hydration must not reload to discover framework dependencies");
    assert.deepEqual(loads, [], "Blocking resources must hydrate without refetching");
    assert.deepEqual(await page.evaluate(() => window.fluxAdapterConformance.initialEnvelope()), expected);
    assert.deepEqual(errors, [], "Cold hydration must not report React errors");
    assert.deepEqual([...origins], [host.baseUrl], "Hydration must use only the public origin");

    // Modify only this consumer's temporary page and require automatic browser
    // synchronization and fresh SSR on the same public HTTP/HMR origin.
    await page.goto(host.baseUrl);
    await page.waitForFunction(() => document.querySelector('[data-testid="home-page"]')?.getAttribute("data-hydrated") === "true");
    const beforeNavigation = documents;
    await page.getByRole("link", { name: "Manage rooms" }).click();
    await page.getByRole("heading", { name: "Rooms", exact: true }).waitFor();
    await delay(750);
    assert.equal(documents, beforeNavigation, "First lazy-page navigation must not reload to optimize dependencies");
    await page.goto(host.baseUrl);
    await page.waitForFunction(() => document.querySelector('[data-testid="home-page"]')?.getAttribute("data-hydrated") === "true");
    const source = path.join(frontend, "src/flux-pages/home/index.tsx");
    const before = fs.readFileSync(source, "utf8");
    try {
      fs.writeFileSync(source, before.replace("Control Center", "Updated Control Center"));
      await page.getByRole("heading", { name: "Updated Control Center", exact: true }).waitFor({ timeout: 20_000 });
      assert.match(await (await fetch(host.baseUrl)).text(), /Updated Control Center/);
      assert.deepEqual(errors, [], "Source synchronization must not report React errors");
      assert.deepEqual([...socketOrigins], [host.baseUrl], "HMR must not bind a second browser port");
    } finally { fs.writeFileSync(source, before); }
    await context.close();
    console.log(`Cold ${published ? "published" : "packed"} hydration: identical envelope, no reload/refetch, one origin; source edits update browser and SSR automatically.`);
  } finally {
    try { await browser?.close(); }
    finally {
      try { await host.stop(); }
      finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
      }
    }
  }
}
async function contracts(python, production) {
  const [port, backendPort] = await ports();
  const before = snapshot();
  run(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", path.join(repository, "tests/adapter-conformance/playwright.config.ts")], repository, {
    ...env, FLUXFAST_ADAPTER_HARNESS: "react", FLUXFAST_CONFORMANCE_ROOT: temporary,
    FLUXFAST_REACT_FRONTEND_ROOT: frontend, FLUXFAST_E2E_PYTHON: python,
    FLUXFAST_E2E_PORT: String(port), FLUXFAST_E2E_BACKEND_PORT: String(backendPort),
    FLUXFAST_E2E_PRODUCTION: production ? "1" : "0", FLUXFAST_CONFORMANCE_SKIP_BUILD: "1",
    FLUXFAST_CONFORMANCE_OUTPUT_DIR: path.join(temporary, "test-results", production ? "production" : "development"),
  });
  assert.deepEqual(snapshot(), before, "Browser execution must leave inputs and built outputs unchanged");
}

try {
  assert.ok(path.relative(repository, temporary).startsWith(".." + path.sep), "Consumer must be outside the checkout");
  if (published) await waitForReactPublication(published);
  fs.mkdirSync(frontend, { recursive: true });
  const virtualenv = path.join(temporary, "python");
  run(bootstrap, ["-m", "venv", virtualenv]);
  const python = path.join(virtualenv, windows ? "Scripts/python.exe" : "bin/python");
  const fluxfast = path.join(virtualenv, windows ? "Scripts/fluxfast.exe" : "bin/fluxfast");
  if (!configuredArtifacts && !published) {
    fs.mkdirSync(path.join(artifacts, "npm"), { recursive: true }); fs.mkdirSync(path.join(artifacts, "python"));
    for (const owner of REACT_RELEASE_PACKAGES) {
      run(pnpm, ["--filter", "@fluxfast/" + owner, "run", "build"], repository);
      run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", path.join(artifacts, "npm")], path.join(repository, "packages", owner));
    }
    run(python, ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", path.join(artifacts, "python"), path.join(repository, "python/fluxfast")]);
  }
  const tooling = createRequire(path.join(repository, "packages/vite/package.json"));
  const versions = Object.fromEntries(["react", "react-dom", "vite", "typescript", "@types/node", "@types/react", "@types/react-dom"].map(name => [name, JSON.parse(fs.readFileSync(tooling.resolve(name + "/package.json"), "utf8")).version]));
  if (process.env.FLUXFAST_REACT_CONSUMER_VERSION) versions.react = versions["react-dom"] = process.env.FLUXFAST_REACT_CONSUMER_VERSION;
  const version = published?.version ?? JSON.parse(fs.readFileSync(path.join(repository, "packages/vite/package.json"), "utf8")).version;
  fs.writeFileSync(path.join(frontend, "package.json"), JSON.stringify({ private: true, type: "module",
    dependencies: { "@fluxfast/vite": version, ...versions }, scripts: { dev: "node -e 'throw Error()'", build: "node -e 'throw Error()'", start: "node -e 'throw Error()'" } }));
  const npmPackages = published?.npmSpecs ?? REACT_RELEASE_PACKAGES.map(owner => one(path.join(artifacts, "npm"), "fluxfast-" + owner + "-", ".tgz"));
  run(npm, ["install", ...npmPackages, "--registry=https://registry.npmjs.org/", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--no-package-lock"], frontend);
  for (const owner of REACT_RELEASE_PACKAGES) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(frontend, "node_modules/@fluxfast", owner, "package.json"), "utf8")).version,
      version, "consumer must install the matching " + owner + " distribution");
  }
  for (const name of ["next", "@fluxfast/next"]) assert.equal(fs.existsSync(path.join(frontend, "node_modules", name)), false);
  run(python, ["-m", "pip", "install", "--quiet", ...(published ? ["--index-url", "https://pypi.org/simple", "--only-binary=fluxfast"] : []),
    published?.pythonSpec ?? one(path.join(artifacts, "python"), "fluxfast-", ".whl")]);
  run(python, ["-c", "import fluxfast,sys; from pathlib import Path; from importlib.metadata import version; assert Path(fluxfast.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()); assert version('fluxfast') == sys.argv[1]", version]);
  for (const name of ["tests/__init__.py", "tests/browser/__init__.py", "tests/browser/backend.py", "tests/browser/conformance.py"]) {
    const output = path.join(temporary, name); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(repository, name), output);
  }
  prepareReactFixture({ source: path.join(repository, "tests/browser/frontend"), frontend });
  fs.copyFileSync(path.join(fixture, "src/Application.tsx"), path.join(frontend, "src/Application.tsx"));
  fs.copyFileSync(path.join(fixture, "tsconfig.json"), path.join(frontend, "tsconfig.json"));
  // Original Vite configuration is preserved; real init creates the wrapper and template.
  fs.copyFileSync(path.join(fixture, "fluxfast.vite.config.mjs"), path.join(frontend, "vite.config.mjs"));
  run(npm, ["exec", "--no", "--", "fluxfast-vite", "init"], frontend);
  run(fluxfast, ["types", "tests.browser.backend:app", "--frontend", frontend]);
  run(fluxfast, ["types", "tests.browser.backend:app", "--frontend", frontend, "--check"]);
  // The fixture's opt-in facade imports a type only; retain its declaration for tsc.
  // That original relative path belongs to the workspace fixture, so relocate
  // only this test-only type import into the isolated frontend before checking.
  const probe = path.join(frontend, "src/components/ConformanceProbe.tsx");
  fs.copyFileSync(path.join(repository, "tests/adapter-conformance/harness.ts"), path.join(frontend, "src/ConformanceHarness.ts"));
  fs.writeFileSync(probe, fs.readFileSync(probe, "utf8").replace('"../../../../adapter-conformance/harness"', '"../ConformanceHarness"'));
  run(npm, ["exec", "--no", "--", "tsc", "--noEmit"], frontend);
  await coldHydrationAndReload(python);
  await contracts(python, false);
  run(fluxfast, ["build", "--app", "tests.browser.backend:app", "--frontend", frontend]);
  run(fluxfast, ["doctor", "--production", "--app", "tests.browser.backend:app", "--frontend", frontend, "--strict"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(frontend, "dist/fluxfast/host.json"), "utf8"));
  for (const name of manifest.assets.filter(name => /\.m?js$/.test(name))) {
    const source = fs.readFileSync(path.join(frontend, "dist/fluxfast/client", name), "utf8");
    assert.equal(/@fluxfast\/(?:next|codegen)|FLUXFAST_BACKEND_URL|FLUXFAST_PRODUCTION_START|["']node:/.test(source), false, "Forbidden client dependency in " + name);
  }
  for (const name of ["src", "fluxfast.html", "fluxfast.vite.config.mjs", "vite.config.mjs", "node_modules/vite", "node_modules/@fluxfast/codegen", "node_modules/typescript"]) fs.rmSync(path.join(frontend, name), { recursive: true, force: true });
  await contracts(python, true);
  console.log(`${published ? "Published" : "Packed"} FluxFast ${version}, React ${versions.react}: conformance passes in both modes; production hydrates without Next, source, Vite, Codegen or TypeScript.`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
