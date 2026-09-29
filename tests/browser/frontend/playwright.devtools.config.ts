import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const repositoryRoot = path.resolve(__dirname, "../../..");
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const port = Number(process.env.FLUXFAST_E2E_DEVTOOLS_PORT ?? "3160");
const developmentEnvironment = { ...process.env };
delete developmentEnvironment.CI;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "devtools.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `exec ${JSON.stringify(python)} -m fluxfast.cli dev tests.browser.backend:app --frontend tests/browser/frontend --frontend-port ${port} --no-reload`,
    cwd: repositoryRoot,
    env: {
      ...developmentEnvironment,
      FLUXFAST_E2E_DEVTOOLS: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
