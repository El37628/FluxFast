import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createProcessHarness } from "../process-harness.mjs";

/** React/Vite uses the real Python CLI and the unchanged shared expectations. */
export function createReactHarness({ root = process.cwd() } = {}) {
  root = process.env.FLUXFAST_CONFORMANCE_ROOT ?? root;
  const frontend = process.env.FLUXFAST_REACT_FRONTEND_ROOT ?? path.join(root, "tests/browser/react-frontend");
  const production = process.env.FLUXFAST_E2E_PRODUCTION === "1";
  const port = Number(process.env.FLUXFAST_E2E_PORT ?? (production ? "3170" : "3160"));
  const backendPort = Number(process.env.FLUXFAST_E2E_BACKEND_PORT ?? (port + 1));
  const localPython = path.join(root, ".venv/bin/python");
  const python = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
  const env = {
    ...process.env,
    FLUXFAST_E2E_DEVTOOLS: production ? "0" : "1",
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
  const harness = createProcessHarness({
    name: "react", baseUrl, readyUrl: baseUrl + "/fluxfast/readyz",
    command: python, args, cwd: root, env, additionalPorts: [backendPort], requireZeroExit: true,
  });
  return {
    name: "react", baseUrl,
    build() {
      return new Promise((resolve, reject) => {
        const child = spawn(python, ["-m", "fluxfast.cli", "build", "--app", "tests.browser.backend:app", "--frontend", frontend], { cwd: root, env, shell: false, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`React fixture build failed (${code ?? signal})`)));
      });
    },
    async start() {
      await harness.start();
      for (const entries of Object.values(os.networkInterfaces())) {
        for (const address of entries ?? []) {
          if (address.internal || address.family !== "IPv4") continue;
          const connected = await new Promise(resolve => {
            const socket = net.connect({ host: address.address, port: backendPort });
            const finish = value => { socket.destroy(); resolve(value); };
            socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
            socket.setTimeout(1_000, () => finish(false));
          });
          assert.equal(connected, false, "FastAPI must not bind to a non-loopback interface");
        }
      }
    },
    stop: () => harness.stop(),
  };
}
