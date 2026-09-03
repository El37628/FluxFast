import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const fluxfast = process.env.FLUXFAST_E2E_FLUXFAST;
const requireFromConsumer = createRequire(path.join(consumerRoot, "package.json"));
const { chromium } = requireFromConsumer("@playwright/test");
const production = process.env.FLUXFAST_CONSUMER_PRODUCTION === "1";
const published = process.env.FLUXFAST_CONSUMER_PUBLISHED === "1";
const ignoredTopLevel = new Set([
  ".next",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function availablePorts(count) {
  const servers = Array.from({ length: count }, () => net.createServer());
  try {
    await Promise.all(
      servers.map(
        server => new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        })
      )
    );
    return servers.map(server => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      if (!port) throw new Error("Could not allocate a consumer port.");
      return port;
    });
  } finally {
    await Promise.all(
      servers.map(
        server => server.listening
          ? new Promise((resolve, reject) =>
              server.close(error => (error ? reject(error) : resolve()))
            )
          : Promise.resolve()
      )
    );
  }
}

function snapshotConsumerInputs() {
  const snapshot = new Map();

  function visit(absolute, relative) {
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (!relative && ignoredTopLevel.has(name)) continue;
        const childRelative = relative ? path.join(relative, name) : name;
        visit(path.join(absolute, name), childRelative);
      }
      return;
    }

    const record = {
      mode: stat.mode.toString(),
      type: stat.isSymbolicLink() ? "symlink" : "file",
    };
    if (stat.isSymbolicLink()) {
      record.target = fs.readlinkSync(absolute);
    } else {
      record.sha256 = crypto
        .createHash("sha256")
        .update(fs.readFileSync(absolute))
        .digest("hex");
    }
    snapshot.set(relative.replaceAll(path.sep, "/"), record);
  }

  visit(consumerRoot, "");
  return snapshot;
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter(
      file => JSON.stringify(before.get(file)) !== JSON.stringify(after.get(file))
    )
    .sort();
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

const [frontendPort, backendPort] = await availablePorts(2);
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const beforeStart = production ? snapshotConsumerInputs() : undefined;
if (production && !fluxfast) {
  throw new Error(
    "FLUXFAST_E2E_FLUXFAST must identify the isolated console command."
  );
}
const command = production
  ? [
      "start",
      "backend:app",
      "--frontend",
      consumerRoot,
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
    ]
  : [
      "-m",
      "fluxfast.cli",
      "dev",
      "backend:app",
      "--frontend",
      consumerRoot,
      "--frontend-port",
      String(frontendPort),
      "--no-reload",
    ];
const child = spawn(
  production ? fluxfast : python,
  command,
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
let gracefulShutdown = false;
let shutdownDuration = 0;

try {
  const deadline = Date.now() + 120_000;
  let html;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `FluxFast ${production ? "start" : "dev"} exited before the frontend was ready.\n${output}`
      );
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

  if (production) {
    assert.match(output, /\[fluxfast\] FastAPI: 127\.0\.0\.1:/);
    assert.match(output, /\[fluxfast\] application ready/);
    const health = await fetch(`${frontendUrl}/_fluxfast/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok" });
    const readiness = await fetch(`${frontendUrl}/_fluxfast/readyz`);
    assert.equal(readiness.status, 200);
    assert.equal(readiness.headers.get("cache-control"), "no-store");
    assert.deepEqual(await readiness.json(), { status: "ready" });
  }

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
  const registrationRequests = [];
  const registrationResponses = [];
  let documentRequests = 0;
  for (const page of [first, second]) {
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const locationUrl = message.location().url;
      if (locationUrl) {
        try {
          if (new URL(locationUrl).pathname === "/registrations") return;
        } catch {
          // Preserve malformed locations as unexpected browser errors.
        }
      }
      browserErrors.push(message.text());
    });
  }
  second.on("request", request => {
    if (request.resourceType() === "document") documentRequests += 1;
    const headers = request.headers();
    if (headers["x-fluxfast"] === "1") protocolOrigins.push(new URL(request.url()).origin);
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/registrations"
    ) {
      registrationRequests.push(request.url());
    }
    if (headers["x-fluxfast-only"]) {
      resourceBatches.push(headers["x-fluxfast-only"].split(",").sort());
    }
  });
  second.on("response", response => {
    if (new URL(response.url()).pathname === "/registrations") {
      registrationResponses.push(response.status());
    }
  });

  await Promise.all([first.goto(frontendUrl), second.goto(frontendUrl)]);
  await second.locator("[data-testid=analytics-loading]").waitFor();
  assert.equal(
    await second.getByRole("heading", { name: "Clean live consumer" }).isVisible(),
    true
  );
  assert.equal(
    await second.getByRole("article", { name: "Featured user" }).textContent(),
    "Ada Lovelaceada@example.com"
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

  const registration = second.getByRole("form", { name: "Registration" });
  await registration.getByRole("button", { name: "Register" }).click();
  const localIssues = registration.getByRole("alert");
  await localIssues.first().waitFor();
  assert.equal(await localIssues.count(), 4);
  assert.deepEqual(await localIssues.allTextContents(), [
    "String must contain at least 2 characters.",
    "String must contain at least 5 characters.",
    "String must contain at least 2 characters.",
    "String must contain at least 3 characters.",
  ]);
  assert.equal(registrationRequests.length, 0);

  await registration.getByLabel("Registration name").fill("Ada Lovelace");
  await registration.getByLabel("Registration email").fill("taken@example.com");
  await registration.getByLabel("Registration city").fill("Kuala Lumpur");
  await registration.getByLabel("Registration postcode").fill("50000");
  await registration.getByRole("button", { name: "Register" }).click();
  await registration.getByText("Email is already registered", { exact: false }).waitFor();
  assert.equal(registrationRequests.length, 1);
  assert.deepEqual(registrationResponses, [422]);

  await registration.getByLabel("Registration email").fill("ada@example.com");
  await registration.getByRole("button", { name: "Register" }).click();
  await registration.getByRole("status").waitFor();
  assert.equal(
    await registration.getByRole("status").textContent(),
    "Registration accepted"
  );
  assert.equal(registrationRequests.length, 2);
  assert.deepEqual(registrationResponses, [422, 200]);

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
    `${production ? "Production" : "Development"} `
      + `${published ? "published" : "packed"} consumer synchronized live resources `
      + `across two clients at ${frontendUrl}.`
  );
} finally {
  await browser?.close();
  const shutdownStartedAt = Date.now();
  if (production && child.exitCode === null) {
    child.kill("SIGTERM");
  } else {
    terminateProcessGroup(child, "SIGTERM");
  }
  gracefulShutdown = await waitForExit(child, 15_000);
  shutdownDuration = Date.now() - shutdownStartedAt;
  if (!gracefulShutdown) {
    terminateProcessGroup(child, "SIGKILL");
    await waitForExit(child, 5_000);
  }
}

if (production) {
  assert.equal(gracefulShutdown, true, "fluxfast start must stop after SIGTERM");
  assert.equal(
    child.exitCode,
    0,
    `fluxfast start exited with status ${child.exitCode}\n${output}`
  );
  assert.equal(child.signalCode, null, "the production supervisor must handle SIGTERM");
  const changed = changedPaths(beforeStart, snapshotConsumerInputs());
  assert.deepEqual(
    changed,
    [],
    `fluxfast start modified consumer source/generated inputs: ${changed.join(", ")}`
  );
  console.log(
    `Production consumer stopped cleanly after SIGTERM in ${shutdownDuration} ms without changing inputs.`
  );
}
