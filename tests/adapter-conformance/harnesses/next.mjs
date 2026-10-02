import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createProcessHarness } from "../process-harness.mjs";

const frontend = "tests/browser/frontend";

function command(root, python, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: root, env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Next fixture command failed (${code ?? signal})`));
    });
  });
}

function canConnect(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

/** Next-specific commands and host configuration stay outside contract tests. */
export function createNextHarness({ root = process.cwd() } = {}) {
  const production = process.env.FLUXFAST_E2E_PRODUCTION === "1";
  const port = Number(process.env.FLUXFAST_E2E_PORT ?? (production ? "3110" : "3100"));
  const backendPort = Number(process.env.FLUXFAST_E2E_BACKEND_PORT ?? (port + 1));
  const localPython = path.join(root, ".venv", "bin", "python");
  const python = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
  const env = {
    ...process.env,
    FLUXFAST_E2E_DEVTOOLS: production ? "0" : "1",
    NEXT_TELEMETRY_DISABLED: "1",
    PYTHONPATH: [path.join(root, "python/fluxfast/src"), root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  delete env.FLUXFAST_BACKEND_URL;
  delete env.NEXT_PUBLIC_FLUXFAST_BACKEND_URL;
  if (!production) delete env.CI;
  const args = ["-m", "fluxfast.cli", production ? "start" : "dev", "tests.browser.backend:app", "--frontend", frontend,
    "--backend-host", "127.0.0.1", "--backend-port", String(backendPort)];
  args.push(...(production
    ? ["--host", "127.0.0.1", "--port", String(port), "--startup-timeout", "90", "--shutdown-timeout", "10"]
    : ["--frontend-host", "127.0.0.1", "--frontend-port", String(port), "--no-reload"]));
  const baseUrl = `http://127.0.0.1:${port}`;
  const processHarness = createProcessHarness({
    name: "next", baseUrl, readyUrl: production ? `${baseUrl}/fluxfast/readyz` : baseUrl,
    command: python, args, cwd: root, env, additionalPorts: [backendPort],
  });
  return {
    name: "next",
    baseUrl,
    async build() {
      await command(root, python, ["-m", "fluxfast.cli", "build", "--app", "tests.browser.backend:app", "--frontend", frontend], env);
    },
    async start() {
      await processHarness.start();
      for (const entries of Object.values(os.networkInterfaces())) {
        for (const address of entries ?? []) {
          if (address.internal || address.family !== "IPv4") continue;
          assert.equal(await canConnect(address.address, backendPort), false, "FastAPI must not bind to a non-loopback interface");
        }
      }
    },
    stop: () => processHarness.stop(),
  };
}
