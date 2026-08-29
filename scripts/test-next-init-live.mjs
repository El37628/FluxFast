import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
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
    "tests.browser.backend:app",
    "--frontend",
    consumerRoot,
    "--frontend-port",
    String(frontendPort),
    "--no-reload",
  ],
  {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
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
        if (html.includes("Create Next App")) break;
      }
    } catch {
      // The supervisor and Next dev server are still starting.
    }
    await delay(500);
  }

  assert.equal(typeof html, "string", `Frontend did not become ready.\n${output}`);
  assert.match(html, /Create Next App/);

  const protocolResponse = await fetch(frontendUrl, {
    headers: { "x-fluxfast": "1" },
  });
  assert.equal(protocolResponse.ok, true);
  const envelope = await protocolResponse.json();
  assert.equal(envelope.page.component, "home/index");
  assert.equal(new URL(protocolResponse.url).origin, new URL(frontendUrl).origin);

  console.log(
    `Initialized packed consumer rendered FastAPI component ${envelope.page.component} at ${frontendUrl}.`
  );
} finally {
  terminateProcessGroup(child, "SIGTERM");
  if (!(await waitForExit(child, 10_000))) {
    terminateProcessGroup(child, "SIGKILL");
    await waitForExit(child, 5_000);
  }
}
