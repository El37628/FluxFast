import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const repositoryRoot = path.resolve(__dirname, "../../..");
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const port = Number(process.env.FLUXFAST_E2E_PORT ?? "3100");
const backendPort = Number(process.env.FLUXFAST_E2E_BACKEND_PORT ?? "3101");
const production = process.env.FLUXFAST_E2E_PRODUCTION === "1";
const backendUrl = `http://127.0.0.1:${backendPort}`;

const developmentServer = {
  command: `exec ${JSON.stringify(python)} -m fluxfast.cli dev tests.browser.backend:app --frontend tests/browser/frontend --frontend-port ${port} --no-reload`,
  cwd: repositoryRoot,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
  },
  url: `http://127.0.0.1:${port}`,
  reuseExistingServer: false,
  timeout: 120_000,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
};

const productionServers = [
  {
    command: `exec ${JSON.stringify(python)} -m uvicorn tests.browser.backend:app --host 127.0.0.1 --port ${backendPort}`,
    cwd: repositoryRoot,
    url: backendUrl,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
  },
  {
    command: `pnpm run start --hostname 127.0.0.1 --port ${port}`,
    cwd: __dirname,
    env: {
      ...process.env,
      FLUXFAST_BACKEND_URL: backendUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
  },
];

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "distributed-live.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: production ? productionServers : developmentServer,
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
