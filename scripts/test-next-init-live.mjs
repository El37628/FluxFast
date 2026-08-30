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

const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python =
  process.env.FLUXFAST_E2E_PYTHON ??
  (fs.existsSync(localPython) ? localPython : "python");
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
  if (!port) throw new Error("Could not allocate a frontend port.");
  return port;
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

const frontendPort = await availablePort();
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const child = spawn(
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
    "--no-reload",
  ],
  {
    cwd: consumerRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      PYTHONPATH: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let output = "";
const recordOutput = chunk => {
  output = `${output}${chunk}`.slice(-50_000);
};
child.stdout.on("data", recordOutput);
child.stderr.on("data", recordOutput);
let browser;

try {
  const deadline = Date.now() + 120_000;
  let html;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`FluxFast dev exited before the frontend was ready.\n${output}`);
    }
    try {
      const response = await fetch(frontendUrl);
      if (response.ok) {
        html = await response.text();
        if (
          html.includes("Clean live consumer") &&
          html.includes("Loading analytics")
        ) {
          break;
        }
      }
    } catch {
      // The supervisor and Next dev server are still starting.
    }
    await delay(500);
  }

  assert.equal(typeof html, "string", `Frontend did not become ready.\n${output}`);
  assert.match(html, /Clean live consumer/);
  assert.match(html, /Loading analytics/);

  const protocolResponse = await fetch(frontendUrl, {
    headers: {
      "x-fluxfast": "1",
      "x-fluxfast-protocol": "1",
      "x-fluxfast-capabilities": "deferred-resources,live-resources",
    },
  });
  assert.equal(protocolResponse.ok, true);
  const envelope = await protocolResponse.json();
  assert.equal(envelope.page.component, "home/index");
  assert.deepEqual(
    [...envelope.resourceKeys].sort(),
    ["analytics", "live-counter", "live-report"]
  );
  assert.deepEqual([...envelope.deferred].sort(), ["analytics", "live-report"]);
  assert.deepEqual(envelope.live, ["live-counter", "live-report"]);
  assert.deepEqual(envelope.resources["live-counter"].value, { value: 0 });
  assert.equal(new URL(protocolResponse.url).origin, new URL(frontendUrl).origin);

  browser = await chromium.launch({ headless: true });
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const browserErrors = [];
  const resourceBatches = [];
  const protocolOrigins = [];
  let documentRequests = 0;
  for (const page of [first, second]) {
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
  }
  second.on("request", request => {
    if (request.resourceType() === "document") documentRequests += 1;
    const headers = request.headers();
    if (headers["x-fluxfast"] === "1") protocolOrigins.push(new URL(request.url()).origin);
    if (headers["x-fluxfast-only"]) {
      resourceBatches.push(headers["x-fluxfast-only"].split(",").sort());
    }
  });

  await Promise.all([first.goto(frontendUrl), second.goto(frontendUrl)]);
  await second.locator("[data-testid=analytics-loading]").waitFor();
  assert.equal(
    await second.getByRole("heading", { name: "Clean live consumer" }).isVisible(),
    true
  );
  const analytics = second.locator("[data-testid=analytics-value]");
  await analytics.waitFor({ timeout: 10_000 });
  assert.match(await analytics.textContent(), /Revenue 120000 from loader [12]/);
  await Promise.all([
    first.locator("[data-testid=live-status]").waitFor(),
    second.locator("[data-testid=live-status]").waitFor(),
  ]);
  await Promise.all([
    first.locator("[data-testid=live-report-value]").waitFor(),
    second.locator("[data-testid=live-report-value]").waitFor(),
  ]);
  assert.equal(await first.locator("[data-testid=live-status]").textContent(), "connected");
  assert.equal(await second.locator("[data-testid=live-status]").textContent(), "connected");
  assert.equal(await second.locator("[data-testid=live-counter-value]").textContent(), "0");
  assert.equal(await second.locator("[data-testid=live-report-value]").textContent(), "0");

  resourceBatches.length = 0;
  await first.getByRole("button", { name: "Increment live resources" }).click();
  await second.locator("[data-testid=live-counter-value]").filter({ hasText: "1" }).waitFor();
  await second.locator("[data-testid=live-report-value]").filter({ hasText: "1" }).waitFor();
  assert.equal(await second.locator("[data-testid=live-report-stale]").count(), 0);
  assert.equal(
    resourceBatches.some(keys => keys.includes("live-counter")),
    true
  );
  assert.equal(
    resourceBatches.some(keys => keys.includes("live-report")),
    true
  );
  assert.equal(documentRequests, 1);
  assert.equal(protocolOrigins.length > 0, true);
  assert.deepEqual([...new Set(protocolOrigins)], [new URL(frontendUrl).origin]);
  assert.deepEqual(browserErrors, []);

  console.log(
    `Initialized packed consumer synchronized live resources across two clients at ${frontendUrl}.`
  );
} finally {
  await browser?.close();
  terminateProcessGroup(child, "SIGTERM");
  if (!(await waitForExit(child, 10_000))) {
    terminateProcessGroup(child, "SIGKILL");
    await waitForExit(child, 5_000);
  }
}
