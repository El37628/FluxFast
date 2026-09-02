import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const repositoryRoot = path.resolve(__dirname, "../../..");
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const redisUrl = process.env.FLUXFAST_TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";
const deployment = `production-browser-${process.pid}-${Date.now()}`;
const frontendPort = Number(process.env.FLUXFAST_E2E_PORT ?? "3150");
const backendPort = Number(process.env.FLUXFAST_E2E_BACKEND_PORT ?? "3151");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "production-distributed.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `exec ${JSON.stringify(python)} -m fluxfast.cli start tests.browser.distributed_backend:app --frontend tests/browser/frontend --host 127.0.0.1 --port ${frontendPort} --backend-host 127.0.0.1 --backend-port ${backendPort} --workers 3 --startup-timeout 90 --shutdown-timeout 15`,
    cwd: repositoryRoot,
    env: {
      ...process.env,
      FLUXFAST_TEST_REDIS_URL: redisUrl,
      FLUXFAST_TEST_CACHE_NAMESPACE: deployment,
      FLUXFAST_TEST_LIVE_PREFIX: `fluxfast:${deployment}:live:`,
      FLUXFAST_TEST_DIAGNOSTIC_PREFIX: `fluxfast:test:${deployment}`,
      FLUXFAST_TEST_WORKER_NAME: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    url: `http://127.0.0.1:${frontendPort}/_fluxfast/readyz`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
