import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { resolvePublishedMixedPairing } from "./published-mixed-config.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "release-consumer", "next-init");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-mixed-published-"));
const consumerRoot = path.join(temporaryRoot, "consumer");
const environmentRoot = path.join(temporaryRoot, "python-environment");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const bootstrapPython = process.env.FLUXFAST_E2E_PYTHON ?? "python";
const repositoryVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
).version;
const pairing = resolvePublishedMixedPairing({
  pairing: process.env.FLUXFAST_PAIRING ?? "python-current",
  releaseVersion: process.env.FLUXFAST_RELEASE_VERSION ?? repositoryVersion,
  previousVersion: process.env.FLUXFAST_PREVIOUS_VERSION ?? "0.5.0"
});
const expectedPythonVersion =
  process.env.FLUXFAST_PYTHON_VERSION?.replace(/^v/, "") ?? pairing.pythonVersion;
const expectedJavaScriptVersion =
  process.env.FLUXFAST_JAVASCRIPT_VERSION?.replace(/^v/, "") ?? pairing.javascriptVersion;
const pythonSpec =
  process.env.FLUXFAST_PYTHON_SPEC ??
  (pairing.mode === "distributed"
    ? `fluxfast[redis]==${expectedPythonVersion}`
    : `fluxfast==${expectedPythonVersion}`);
const coreSpec = process.env.FLUXFAST_CORE_SPEC ?? `@fluxfast/core@${expectedJavaScriptVersion}`;
const nextSpec = process.env.FLUXFAST_NEXT_SPEC ?? `@fluxfast/next@${expectedJavaScriptVersion}`;

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("verify_deps_before_run") ||
      normalized.includes("link_workspace_packages") ||
      normalized.includes("@jsr:registry")
    ) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    NEXT_TELEMETRY_DISABLED: "1",
    PYTHONPATH: "",
    ...extra
  };
}

function runResult(command, args, cwd = repositoryRoot, extraEnvironment = {}) {
  return spawnSync(command, args, {
    cwd,
    env: cleanEnvironment(extraEnvironment),
    stdio: "inherit"
  });
}

function run(command, args, cwd = repositoryRoot, extraEnvironment = {}) {
  const result = runResult(command, args, cwd, extraEnvironment);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close(error => {
      if (error) reject(error);
      else resolve();
    })
  );
  return port;
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") child.kill(signal);
  else process.kill(-child.pid, signal);
}

async function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise(resolve => child.once("exit", () => resolve(true))),
    delay(timeoutMilliseconds).then(() => false)
  ]);
}

function installedPackageVersion(packageName) {
  const packageRoot = fs.realpathSync(
    path.join(consumerRoot, "node_modules", ...packageName.split("/"))
  );
  assert.equal(
    packageRoot.startsWith(`${consumerRoot}${path.sep}`),
    true,
    `${packageName} resolved outside the temporary consumer: ${packageRoot}`
  );
  const manifestPath = path.join(packageRoot, "package.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
}

function assertTraditionalRegistryGeneration() {
  const generatedRoot = path.join(consumerRoot, "src", ".fluxfast");
  const registryPath = path.join(generatedRoot, "pages.generated.ts");
  assert.equal(fs.existsSync(registryPath), true, "traditional page registry was not generated");
  const registry = fs.readFileSync(registryPath, "utf8");
  assert.match(registry, /home\/index/);
  if (pairing.mode === "distributed") assert.match(registry, /details\/index/);

  for (const file of [
    "schema.generated.json",
    "types.generated.ts",
    "routes.generated.ts",
    "mutations.generated.ts"
  ]) {
    assert.equal(
      fs.existsSync(path.join(generatedRoot, file)),
      false,
      `${file} must not be required for an untyped mixed-version consumer`
    );
  }
}

async function installPublishedPython(python) {
  const attempts = process.env.FLUXFAST_PYTHON_SPEC ? 1 : 18;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runResult(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", pythonSpec],
      consumerRoot
    );
    if (!result.error && result.status === 0) return;
    if (result.error) throw result.error;
    if (attempt === attempts) {
      throw new Error(
        `Published Python package ${pythonSpec} was unavailable after ${attempts} attempts.`
      );
    }
    console.log(`Waiting for ${pythonSpec} registry propagation (${attempt}/${attempts})…`);
    await delay(10_000);
  }
}

function installDistributedHarnessDependency(python) {
  if (pairing.mode !== "distributed") return;
  run(
    python,
    ["-m", "pip", "install", "--disable-pip-version-check", "httpx2>=2.0.0,<3.0.0"],
    consumerRoot
  );
}

async function installPublishedJavaScript() {
  const attempts = process.env.FLUXFAST_CORE_SPEC || process.env.FLUXFAST_NEXT_SPEC ? 1 : 18;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runResult(
      npmCommand,
      ["install", "--package-lock=false", "--no-save", coreSpec, nextSpec],
      consumerRoot
    );
    if (!result.error && result.status === 0) return;
    if (result.error) throw result.error;
    if (attempt === attempts) {
      throw new Error(
        `Published JavaScript packages ${coreSpec} and ${nextSpec} were unavailable ` +
          `after ${attempts} attempts.`
      );
    }
    console.log(
      `Waiting for ${coreSpec} and ${nextSpec} registry propagation ` + `(${attempt}/${attempts})…`
    );
    await delay(10_000);
  }
}

let child;
let browser;
try {
  fs.cpSync(fixtureRoot, consumerRoot, { recursive: true });
  run(npmCommand, ["install", "--package-lock=false"], consumerRoot);
  await installPublishedJavaScript();
  assert.equal(installedPackageVersion("@fluxfast/core"), expectedJavaScriptVersion);
  assert.equal(installedPackageVersion("@fluxfast/next"), expectedJavaScriptVersion);

  run(npxCommand, ["--no-install", "fluxfast", "init", "--yes"], consumerRoot);
  fs.copyFileSync(
    path.join(consumerRoot, "fixtures", pairing.frontendFixture),
    path.join(consumerRoot, "src", "flux-pages", "home", "index.tsx")
  );
  if (pairing.mode === "distributed") {
    const detailsRoot = path.join(consumerRoot, "src", "flux-pages", "details");
    fs.mkdirSync(detailsRoot, { recursive: true });
    fs.copyFileSync(
      path.join(consumerRoot, "fixtures", "distributed-details.tsx"),
      path.join(detailsRoot, "index.tsx")
    );
  }
  if (pairing.mode === "legacy") {
    fs.copyFileSync(
      path.join(consumerRoot, "fixtures", pairing.backendFixture),
      path.join(consumerRoot, "backend.py")
    );
  }
  run(npxCommand, ["--no-install", "fluxfast", "generate"], consumerRoot);
  assertTraditionalRegistryGeneration();
  run(npxCommand, ["--no-install", "fluxfast", "init", "--check"], consumerRoot);
  run(npmCommand, ["run", "typecheck"], consumerRoot);
  run(npmCommand, ["run", "build"], consumerRoot);

  run(bootstrapPython, ["-m", "venv", environmentRoot]);
  const python =
    process.platform === "win32"
      ? path.join(environmentRoot, "Scripts", "python.exe")
      : path.join(environmentRoot, "bin", "python");
  run(python, ["-m", "ensurepip", "--upgrade"]);
  await installPublishedPython(python);
  installDistributedHarnessDependency(python);
  run(
    python,
    [
      "-c",
      "import sys; from pathlib import Path; import fluxfast; " +
        "assert fluxfast.__version__ == sys.argv[1]; " +
        "assert Path(fluxfast.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())",
      expectedPythonVersion
    ],
    consumerRoot
  );

  if (pairing.mode === "distributed") {
    if (!process.env.FLUXFAST_TEST_REDIS_URL) {
      throw new Error("FLUXFAST_TEST_REDIS_URL is required for the current-Python mixed pairing.");
    }
    run(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "test-next-init-distributed.mjs"), consumerRoot],
      repositoryRoot,
      { FLUXFAST_E2E_PYTHON: python, PYTHONPATH: "" }
    );
    console.log(
      `Mixed distributed pairing passed: Python ${expectedPythonVersion} + ` +
        `@fluxfast/next ${expectedJavaScriptVersion}.`
    );
  } else {
    const frontendPort = await reservePort();
    const frontendUrl = `http://127.0.0.1:${frontendPort}`;
    child = spawn(
      python,
      [
        "-m",
        "fluxfast.cli",
        "dev",
        "backend:app",
        "--frontend",
        consumerRoot,
        "--frontend-port",
        String(frontendPort),
        "--no-reload"
      ],
      {
        cwd: consumerRoot,
        detached: process.platform !== "win32",
        env: cleanEnvironment(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let output = "";
    const recordOutput = chunk => {
      output += chunk.toString();
      if (output.length > 80_000) output = output.slice(-80_000);
    };
    child.stdout.on("data", recordOutput);
    child.stderr.on("data", recordOutput);

    const deadline = Date.now() + 120_000;
    let html;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Mixed-version supervisor exited before readiness.\n${output}`);
      }
      try {
        const response = await fetch(frontendUrl);
        if (response.ok) {
          const candidate = await response.text();
          if (candidate.includes("Published mixed consumer")) {
            html = candidate;
            break;
          }
        }
      } catch {
        // The supervisor and Next server are still starting.
      }
      await delay(250);
    }

    assert.equal(typeof html, "string", `Frontend did not become ready.\n${output}`);
    assert.match(html, /Published mixed consumer/);
    assert.match(html, /Revenue <!-- -->120000<!-- --> from loader <!-- -->\d+/);
    assert.match(html, new RegExp(`capabilities-value[^>]*>${pairing.expectedCapabilities}<`));
    assert.doesNotMatch(html, /Loading analytics/);

    const protocolResponse = await fetch(frontendUrl, {
      headers: {
        "x-fluxfast": "1",
        "x-fluxfast-protocol": "1"
      }
    });
    assert.equal(protocolResponse.ok, true);
    const envelope = await protocolResponse.json();
    assert.equal(envelope.resources.analytics.value.revenue, 120_000);
    assert.equal("resourceKeys" in envelope, false);
    assert.equal("deferred" in envelope, false);
    assert.equal("live" in envelope, false);
    assert.equal("resourceErrors" in envelope, false);

    const requireFromConsumer = createRequire(path.join(consumerRoot, "package.json"));
    const { chromium } = requireFromConsumer("@playwright/test");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const liveRequests = [];
    const browserErrors = [];
    page.on("request", request => {
      if (request.headers()["x-fluxfast-live"] === "1") liveRequests.push(request.url());
    });
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(frontendUrl);
    await page.getByRole("heading", { name: "Published mixed consumer" }).waitFor();
    assert.equal(
      await page.locator("[data-testid=capabilities-value]").textContent(),
      pairing.expectedCapabilities
    );
    await delay(750);
    assert.deepEqual(liveRequests, []);
    assert.deepEqual(browserErrors, []);

    console.log(
      `Published mixed pairing passed: Python ${expectedPythonVersion} + ` +
        `@fluxfast/next ${expectedJavaScriptVersion} at ${frontendUrl}.`
    );
  }
} finally {
  await browser?.close();
  if (child) {
    terminateProcessGroup(child, "SIGTERM");
    if (!(await waitForExit(child, 10_000))) {
      terminateProcessGroup(child, "SIGKILL");
      await waitForExit(child, 5_000);
    }
  }
  if (process.env.FLUXFAST_KEEP_TEMP === "1") {
    console.log(`Preserved mixed consumer at ${consumerRoot}`);
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
