import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consumerRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!consumerRoot || !fs.existsSync(path.join(consumerRoot, "package.json"))) {
  throw new Error("Expected an initialized consumer directory as the first argument.");
}

const redisUrl = process.env.FLUXFAST_TEST_REDIS_URL;
if (!redisUrl) {
  throw new Error("FLUXFAST_TEST_REDIS_URL is required for the distributed consumer.");
}

const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_E2E_PYTHON ??
  (fs.existsSync(localPython) ? localPython : "python");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const requireFromConsumer = createRequire(path.join(consumerRoot, "package.json"));
const { chromium } = requireFromConsumer("@playwright/test");

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
  if (!port) throw new Error("Could not allocate a consumer port.");
  return port;
}

async function availablePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await availablePort());
  return [...ports];
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else if (child.pid) {
      process.kill(-child.pid, signal);
    }
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

const processes = [];
function start(label, command, args, environment = {}) {
  const childEnvironment = {
    ...process.env,
    ...environment,
    NEXT_TELEMETRY_DISABLED: "1",
    PYTHONPATH: "",
  };
  const child = spawn(command, args, {
    cwd: consumerRoot,
    detached: process.platform !== "win32",
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processRecord = { label, child, output: "" };
  const recordOutput = chunk => {
    processRecord.output = `${processRecord.output}${chunk}`.slice(-50_000);
  };
  child.stdout.on("data", recordOutput);
  child.stderr.on("data", recordOutput);
  processes.push(processRecord);
  return processRecord;
}

function processOutput() {
  return processes
    .map(({ label, output }) => `\n--- ${label} ---\n${output}`)
    .join("");
}

async function waitForUrl(url, processRecord) {
  const deadline = Date.now() + 120_000;
  let consecutiveServerErrors = 0;
  while (Date.now() < deadline) {
    if (processRecord.child.exitCode !== null) {
      throw new Error(`${processRecord.label} exited before ${url} was ready.${processOutput()}`);
    }
    let response;
    try {
      response = await fetch(url);
    } catch {
      // The consumer process is still starting.
    }
    if (response) {
      if (response.ok) return response;
      if (response.status >= 500) {
        consecutiveServerErrors += 1;
        if (consecutiveServerErrors >= 3) {
          const detail = (await response.text()).slice(0, 2_000);
          throw new Error(
            `${url} repeatedly returned HTTP ${response.status}: ${detail}${processOutput()}`
          );
        }
      } else {
        consecutiveServerErrors = 0;
      }
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}.${processOutput()}`);
}

const [frontendPort, proxyPort, workerAPort, workerBPort, workerCPort] =
  await availablePorts(5);
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const workerUrls = {
  A: `http://127.0.0.1:${workerAPort}`,
  B: `http://127.0.0.1:${workerBPort}`,
  C: `http://127.0.0.1:${workerCPort}`,
};
const unique = `${process.pid}-${Date.now()}`;
const run = `release-${unique}`;
const sharedEnvironment = {
  FLUXFAST_TEST_REDIS_URL: redisUrl,
  FLUXFAST_TEST_CACHE_NAMESPACE: `release-${unique}`,
  FLUXFAST_TEST_LIVE_PREFIX: `fluxfast:release:${unique}:`,
  FLUXFAST_TEST_DIAGNOSTIC_PREFIX: `fluxfast:release:${unique}:diagnostics`,
};

let browser;
const contexts = [];
try {
  const workers = Object.entries(workerUrls).map(([name, url]) => {
    const port = new URL(url).port;
    return start(
      `worker ${name}`,
      python,
      [
        "-m",
        "uvicorn",
        "distributed_backend:app",
        "--host",
        "127.0.0.1",
        "--port",
        port,
        "--workers",
        "1",
      ],
      { ...sharedEnvironment, FLUXFAST_TEST_WORKER_NAME: name }
    );
  });
  await Promise.all(
    workers.map((worker, index) =>
      waitForUrl(`${Object.values(workerUrls)[index]}/health`, worker)
    )
  );

  const proxy = start(
    "worker proxy",
    python,
    [
      "-m",
      "uvicorn",
      "distributed_proxy:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(proxyPort),
    ],
    {
      FLUXFAST_TEST_WORKER_A_URL: workerUrls.A,
      FLUXFAST_TEST_WORKER_B_URL: workerUrls.B,
      FLUXFAST_TEST_WORKER_C_URL: workerUrls.C,
    }
  );
  await waitForUrl(`${proxyUrl}/health`, proxy);

  const frontend = start(
    "Next.js frontend",
    npmCommand,
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(frontendPort)],
    { FLUXFAST_BACKEND_URL: proxyUrl }
  );
  const firstUrl = `${frontendUrl}/?${new URLSearchParams({ run, client: "a" })}`;
  const readyResponse = await waitForUrl(firstUrl, frontend);
  const readyHtml = await readyResponse.text();
  assert.match(readyHtml, /Clean distributed consumer/);
  assert.match(readyHtml, /Loading counter/);

  browser = await chromium.launch({ headless: true });
  const browserErrors = [];
  const protocolOrigins = [];

  function newPage() {
    return browser.newContext().then(context => {
      contexts.push(context);
      return context.newPage().then(page => {
        page.on("pageerror", error => browserErrors.push(error.message));
        page.on("console", message => {
          if (message.type() === "error") browserErrors.push(message.text());
        });
        page.on("request", request => {
          if (request.headers()["x-fluxfast"] === "1") {
            protocolOrigins.push(new URL(request.url()).origin);
          }
        });
        return page;
      });
    });
  }

  const first = await newPage();
  await first.goto(firstUrl);
  await first.getByTestId("distributed-counter-loading").waitFor();
  await first.getByTestId("distributed-counter-value").waitFor({ timeout: 15_000 });
  assert.equal(
    await first.getByTestId("distributed-counter-value").textContent(),
    "0 loaded by A"
  );
  await first.getByTestId("distributed-live-status").filter({ hasText: "connected" }).waitFor();

  const diagnosticsUrl = `${workerUrls.A}/diagnostics?run=${encodeURIComponent(run)}`;
  let diagnosticsResponse = await fetch(diagnosticsUrl);
  assert.equal(diagnosticsResponse.ok, true);
  let diagnostics = await diagnosticsResponse.json();
  assert.deepEqual(diagnostics.records["loader:a"], [diagnostics.records["page:a"][0]]);
  assert.match(diagnostics.records["loader:a"][0], /^A:\d+$/);
  assert.deepEqual(diagnostics.records["loader:b"], []);

  const second = await newPage();
  const secondUrl = `${frontendUrl}/?${new URLSearchParams({ run, client: "b" })}`;
  await second.goto(secondUrl);
  await second.getByTestId("distributed-counter-value").waitFor({ timeout: 15_000 });
  assert.equal(
    await second.getByTestId("distributed-counter-value").textContent(),
    "0 loaded by A"
  );
  await second.getByTestId("distributed-live-status").filter({ hasText: "connected" }).waitFor();

  diagnosticsResponse = await fetch(diagnosticsUrl);
  diagnostics = await diagnosticsResponse.json();
  assert.deepEqual(diagnostics.records["loader:b"], []);
  assert.match(diagnostics.records["page:b"][0], /^B:\d+$/);

  await first.getByRole("button", { name: "Increment distributed counter" }).click();
  await Promise.all(
    [first, second].map(page =>
      page
        .getByTestId("distributed-counter-value")
        .filter({ hasText: /^1 loaded by [AB]$/ })
        .waitFor({ timeout: 15_000 })
    )
  );

  const third = await newPage();
  const thirdUrl = `${frontendUrl}/?${new URLSearchParams({ run, client: "c" })}`;
  await third.goto(thirdUrl);
  await third.getByTestId("distributed-counter-value").filter({ hasText: /^1 loaded by [AB]$/ }).waitFor({
    timeout: 15_000,
  });
  await third.getByTestId("distributed-live-status").filter({ hasText: "connected" }).waitFor();

  diagnosticsResponse = await fetch(diagnosticsUrl);
  assert.equal(diagnosticsResponse.ok, true);
  diagnostics = await diagnosticsResponse.json();
  const records = diagnostics.records;
  assert.equal(diagnostics.state, 1);
  assert.match(records["page:a"][0], /^A:\d+$/);
  assert.match(records["page:b"][0], /^B:\d+$/);
  assert.match(records["page:c"][0], /^C:\d+$/);
  assert.match(records["stream:b"][0], /^B:\d+$/);
  assert.match(records["refresh:b"][0], /^B:\d+$/);
  assert.match(records.mutation[0], /^C:\d+$/);
  assert.deepEqual(records["loader:c"], []);
  assert.equal(
    new Set([records["page:a"][0], records["page:b"][0], records["page:c"][0]]).size,
    3
  );
  assert.equal(protocolOrigins.length > 0, true);
  assert.deepEqual([...new Set(protocolOrigins)], [new URL(frontendUrl).origin]);
  assert.deepEqual(browserErrors, []);

  console.log(
    "Built FluxFast packages synchronized a deferred Redis resource across " +
      `workers A, B, and C at ${frontendUrl}.`
  );
} catch (error) {
  if (error instanceof Error) error.message = `${error.message}${processOutput()}`;
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
  await browser?.close();
  try {
    await fetch(`${workerUrls.A}/diagnostics?run=${encodeURIComponent(run)}`, {
      method: "DELETE",
    });
  } catch {
    // A failed test may already have stopped a worker.
  }
  for (const { child } of [...processes].reverse()) terminateProcessGroup(child, "SIGTERM");
  const exited = await Promise.all(
    [...processes].reverse().map(({ child }) => waitForExit(child, 10_000))
  );
  [...processes].reverse().forEach(({ child }, index) => {
    if (!exited[index]) terminateProcessGroup(child, "SIGKILL");
  });
  await Promise.all(processes.map(({ child }) => waitForExit(child, 5_000)));
}
