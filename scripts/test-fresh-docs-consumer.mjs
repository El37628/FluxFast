import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extractFreshConsumerFiles } from "./fresh-consumer-docs.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = path.join(repositoryRoot, "docs", "getting-started.md");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-fresh-docs-"));
const consumerRoot = path.join(temporaryRoot, "hello-fluxfast");
const frontendRoot = path.join(consumerRoot, "frontend");
const artifactRoot = path.join(temporaryRoot, "artifacts");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const pythonCommand = process.env.FLUXFAST_E2E_PYTHON
  ?? (fs.existsSync(localPython) ? localPython : "python");

function environment(extra = {}) {
  const result = { ...process.env };
  for (const key of Object.keys(result)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("verify_deps_before_run") ||
      normalized.includes("link_workspace_packages") ||
      normalized.includes("@jsr:registry")
    ) {
      delete result[key];
    }
  }
  return {
    ...result,
    NEXT_TELEMETRY_DISABLED: "1",
    PYTHONPATH: "",
    ...extra,
  };
}

function run(command, args, cwd = repositoryRoot, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment(extraEnvironment),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function write(relativePath, content) {
  const destination = path.resolve(consumerRoot, relativePath);
  const relative = path.relative(consumerRoot, destination);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new TypeError(`Consumer file escaped its temporary root: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function oneArtifact(prefix, suffix) {
  const matches = fs.readdirSync(artifactRoot)
    .filter(file => file.startsWith(prefix) && file.endsWith(suffix));
  assert.equal(
    matches.length,
    1,
    `expected one ${prefix}*${suffix} artifact, received ${matches.join(", ") || "none"}`
  );
  return path.join(artifactRoot, matches[0]);
}

function assertOutsideRepository() {
  const relative = path.relative(repositoryRoot, consumerRoot);
  assert.equal(
    path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`),
    true,
    "the fresh consumer must be created outside the repository"
  );
}

function assertInstalledPackage(packageName) {
  const packageRoot = fs.realpathSync(
    path.join(frontendRoot, "node_modules", ...packageName.split("/"))
  );
  const relative = path.relative(frontendRoot, packageRoot);
  assert.equal(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    true,
    `${packageName} must resolve inside the fresh consumer`
  );
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function availablePorts(count) {
  const servers = Array.from({ length: count }, () => net.createServer());
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    })));
    return servers.map(server => {
      const address = server.address();
      assert.equal(typeof address, "object");
      assert.ok(address?.port);
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(server => server.listening
      ? new Promise((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()));
        })
      : Promise.resolve()));
  }
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ESRCH")) throw error;
  }
}

async function waitForExit(child, timeout) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise(resolve => child.once("exit", () => resolve(true))),
    delay(timeout).then(() => false),
  ]);
}

async function verifyProductionStart(fluxfast) {
  const [frontendPort, backendPort] = await availablePorts(2);
  const publicUrl = `http://127.0.0.1:${frontendPort}`;
  const child = spawn(fluxfast, [
    "start",
    "backend.main:app",
    "--frontend",
    "frontend",
    "--host",
    "127.0.0.1",
    "--port",
    String(frontendPort),
    "--backend-host",
    "127.0.0.1",
    "--backend-port",
    String(backendPort),
    "--startup-timeout",
    "90",
    "--shutdown-timeout",
    "10",
  ], {
    cwd: consumerRoot,
    detached: process.platform !== "win32",
    env: environment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const record = chunk => {
    output = `${output}${chunk}`.slice(-50_000);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  try {
    const deadline = Date.now() + 120_000;
    let homeHtml;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`fluxfast start exited before readiness.\n${output}`);
      }
      try {
        const response = await fetch(publicUrl);
        if (response.ok) {
          const body = await response.text();
          if (body.includes("FluxFast starter") && body.includes("Hello from FastAPI")) {
            homeHtml = body;
            break;
          }
        }
      } catch {
        // Both supervised processes are still starting.
      }
      await delay(500);
    }
    assert.equal(typeof homeHtml, "string", `public frontend did not become ready.\n${output}`);

    const about = await fetch(`${publicUrl}/about`);
    assert.equal(about.status, 200);
    assert.match(await about.text(), /About this app/);

    const health = await fetch(`${publicUrl}/_fluxfast/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const ready = await fetch(`${publicUrl}/_fluxfast/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });

    const protocol = await fetch(publicUrl, {
      headers: {
        "x-fluxfast": "1",
        "x-fluxfast-protocol": "1",
        "x-fluxfast-capabilities": "deferred-resources,live-resources",
      },
    });
    assert.equal(protocol.status, 200);
    const envelope = await protocol.json();
    assert.equal(envelope.page.component, "home/index");
    assert.deepEqual(envelope.resourceKeys, ["site-summary"]);
    assert.deepEqual(envelope.resources["site-summary"].value, {
      message: "Hello from FastAPI",
      visits: 0,
    });
  } finally {
    terminateProcessGroup(child, "SIGTERM");
    const gracefulShutdown = await waitForExit(child, 20_000);
    if (!gracefulShutdown) {
      terminateProcessGroup(child, "SIGKILL");
      await waitForExit(child, 5_000);
      throw new Error(`fluxfast start did not shut down gracefully.\n${output}`);
    }
    assert.equal(child.exitCode, 0, `fluxfast start exited with status ${child.exitCode}.\n${output}`);
    assert.equal(child.signalCode, null, "fluxfast start must handle SIGTERM");
  }
}

assertOutsideRepository();
let completed = false;
try {
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(consumerRoot, { recursive: true });
  run(npxCommand, [
    "--yes",
    "create-next-app@16",
    "frontend",
    "--ts",
    "--eslint",
    "--app",
    "--src-dir",
    "--no-tailwind",
    "--use-npm",
    "--import-alias=@/*",
    "--yes",
  ], consumerRoot);

  run(pnpmCommand, ["--filter", "@fluxfast/core", "run", "build"]);
  run(pnpmCommand, ["--filter", "@fluxfast/next", "run", "build"]);
  run(npmCommand, [
    "pack",
    path.join(repositoryRoot, "packages", "core"),
    "--pack-destination",
    artifactRoot,
    "--silent",
  ]);
  run(npmCommand, [
    "pack",
    path.join(repositoryRoot, "packages", "next"),
    "--pack-destination",
    artifactRoot,
    "--silent",
  ]);

  const pythonEnvironment = path.join(temporaryRoot, "python-environment");
  run(pythonCommand, ["-m", "venv", pythonEnvironment]);
  const isolatedPython = process.platform === "win32"
    ? path.join(pythonEnvironment, "Scripts", "python.exe")
    : path.join(pythonEnvironment, "bin", "python");
  const fluxfast = path.join(
    path.dirname(isolatedPython),
    process.platform === "win32" ? "fluxfast.exe" : "fluxfast"
  );
  run(isolatedPython, [
    "-m",
    "pip",
    "wheel",
    "--quiet",
    "--no-deps",
    "--wheel-dir",
    artifactRoot,
    path.join(repositoryRoot, "python", "fluxfast"),
  ]);
  run(isolatedPython, ["-m", "pip", "install", "--quiet", oneArtifact("fluxfast-", ".whl")]);
  run(isolatedPython, [
    "-c",
    "import fluxfast, sys; from pathlib import Path; "
      + "assert Path(fluxfast.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())",
  ]);

  run(npmCommand, [
    "install",
    "--package-lock=false",
    "--no-save",
    oneArtifact("fluxfast-core-", ".tgz"),
    oneArtifact("fluxfast-next-", ".tgz"),
  ], frontendRoot);
  const coreVersion = assertInstalledPackage("@fluxfast/core");
  const nextVersion = assertInstalledPackage("@fluxfast/next");
  assert.equal(coreVersion, nextVersion, "the installed Core and Next packages must match");
  run(npxCommand, ["--no-install", "fluxfast", "init", "--yes"], frontendRoot);

  const documentedFiles = extractFreshConsumerFiles(fs.readFileSync(guidePath, "utf8"));
  for (const [file, content] of documentedFiles) write(file, content);
  write("backend/__init__.py", "");

  run(fluxfast, ["types", "backend.main:app", "--frontend", "frontend"], consumerRoot);
  run(fluxfast, [
    "types",
    "backend.main:app",
    "--frontend",
    "frontend",
    "--check",
  ], consumerRoot);
  run(npxCommand, ["--no-install", "fluxfast", "init", "--check"], frontendRoot);
  run(npxCommand, ["--no-install", "fluxfast", "doctor"], frontendRoot);
  run(npxCommand, ["--no-install", "next", "typegen"], frontendRoot);
  run(npxCommand, ["--no-install", "tsc", "--noEmit"], frontendRoot);

  const generatedRoot = path.join(frontendRoot, "src", ".fluxfast");
  const schema = JSON.parse(
    fs.readFileSync(path.join(generatedRoot, "schema.generated.json"), "utf8")
  );
  assert.deepEqual(Object.keys(schema.resources), ["site-summary"]);
  assert.equal(schema.pages.some(page => page.path === "/" && page.name === "home"), true);
  assert.equal(schema.pages.some(page => page.path === "/about" && page.name === "about"), true);
  assert.equal(
    schema.mutations.some(item => item.name === "increment_visits" && item.path === "/visits"),
    true
  );
  assert.match(
    fs.readFileSync(path.join(generatedRoot, "validators.generated.ts"), "utf8"),
    /export const IncrementVisitsBodyValidator/
  );
  assert.match(
    fs.readFileSync(path.join(generatedRoot, "mutations.generated.ts"), "utf8"),
    /incrementVisits:/
  );

  run(fluxfast, [
    "build",
    "--app",
    "backend.main:app",
    "--frontend",
    "frontend",
  ], consumerRoot);
  run(fluxfast, [
    "doctor",
    "--production",
    "--strict",
    "--app",
    "backend.main:app",
    "--frontend",
    "frontend",
    "--backend-host",
    "127.0.0.1",
    "--workers",
    "1",
  ], consumerRoot);
  await verifyProductionStart(fluxfast);
  completed = true;
  console.log("Fresh documentation-only FluxFast consumer passed.");
} finally {
  if (process.env.FLUXFAST_KEEP_TEMP === "1") {
    console.log(`Preserved fresh consumer at ${consumerRoot}`);
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  if (!completed) process.exitCode = 1;
}
