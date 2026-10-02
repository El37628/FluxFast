import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createProcessHarness } from "./process-harness.mjs";

/** Same three-worker Redis tests, with a real React production supervisor. */
export default async function setup(config) {
  const { root, port } = config.metadata.conformance;
  const backendPort = Number(process.env.FLUXFAST_E2E_BACKEND_PORT ?? String(port + 1));
  const localPython = path.join(root, ".venv/bin/python");
  const python = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
  const deployment = "react-production-" + randomUUID();
  const env = {
    ...process.env,
    PYTHONPATH: [path.join(root, "python/fluxfast/src"), root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    FLUXFAST_TEST_REDIS_URL: process.env.FLUXFAST_TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15",
    FLUXFAST_TEST_CACHE_NAMESPACE: deployment,
    FLUXFAST_TEST_LIVE_PREFIX: `fluxfast:${deployment}:live:`,
    FLUXFAST_TEST_DIAGNOSTIC_PREFIX: `fluxfast:test:${deployment}`,
    FLUXFAST_TEST_WORKER_NAME: "production",
  };
  delete env.FLUXFAST_BACKEND_URL;
  delete env.NEXT_PUBLIC_FLUXFAST_BACKEND_URL;
  const baseUrl = `http://127.0.0.1:${port}`;
  const host = createProcessHarness({
    name: "react-three-worker-production", baseUrl, readyUrl: baseUrl + "/fluxfast/readyz",
    command: python, args: ["-m", "fluxfast.cli", "start", "tests.browser.distributed_backend:app",
      "--frontend", "tests/browser/react-frontend", "--host", "127.0.0.1", "--port", String(port),
      "--backend-host", "127.0.0.1", "--backend-port", String(backendPort), "--workers", "3",
      "--startup-timeout", "90", "--shutdown-timeout", "15"],
    cwd: root, env, additionalPorts: [backendPort], shutdownTimeout: 25_000, requireZeroExit: true,
  });
  try { await host.start(); }
  catch (error) { await host.stop(); throw error; }
  return async () => {
    await host.stop();
    console.log("✓ React three-worker supervisor exited cleanly; public and private ports released");
  };
}
