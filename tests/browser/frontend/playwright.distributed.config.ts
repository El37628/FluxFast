import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const repositoryRoot = path.resolve(__dirname, "../../..");
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const redisUrl = process.env.FLUXFAST_TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";
const deployment = `browser-${process.pid}-${Date.now()}`;
const frontendPort = 3130;
const proxyPort = 3131;
const workerPorts = [3132, 3133, 3134];
const workerUrls = workerPorts.map(port => `http://127.0.0.1:${port}`);
const commonEnvironment = {
  ...process.env,
  FLUXFAST_TEST_REDIS_URL: redisUrl,
  FLUXFAST_TEST_CACHE_NAMESPACE: deployment,
  FLUXFAST_TEST_LIVE_PREFIX: `fluxfast:${deployment}:live:`,
  FLUXFAST_TEST_DIAGNOSTIC_PREFIX: `fluxfast:test:${deployment}`,
};

const workerServers = workerPorts.map((port, index) => ({
  command: `exec ${JSON.stringify(python)} -m uvicorn tests.browser.distributed_backend:app --host 127.0.0.1 --port ${port}`,
  cwd: repositoryRoot,
  env: {
    ...commonEnvironment,
    FLUXFAST_TEST_WORKER_NAME: ["A", "B", "C"][index],
  },
  url: `http://127.0.0.1:${port}/health`,
  reuseExistingServer: false,
  timeout: 120_000,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
}));

export default defineConfig({
  testDir: "./e2e",
  testMatch: "distributed-live.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: "retain-on-failure",
  },
  webServer: [
    ...workerServers,
    {
      command: `exec ${JSON.stringify(python)} -m uvicorn tests.browser.distributed_proxy:app --host 127.0.0.1 --port ${proxyPort}`,
      cwd: repositoryRoot,
      env: {
        ...process.env,
        FLUXFAST_TEST_WORKER_A_URL: workerUrls[0],
        FLUXFAST_TEST_WORKER_B_URL: workerUrls[1],
        FLUXFAST_TEST_WORKER_C_URL: workerUrls[2],
      },
      url: `http://127.0.0.1:${proxyPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
    },
    {
      command: `pnpm run dev --hostname 127.0.0.1 --port ${frontendPort}`,
      cwd: __dirname,
      env: {
        ...process.env,
        FLUXFAST_BACKEND_URL: `http://127.0.0.1:${proxyPort}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      url: `http://127.0.0.1:${frontendPort}/distributed-live?run=health&client=a`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
