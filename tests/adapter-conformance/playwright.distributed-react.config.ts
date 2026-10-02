import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.FLUXFAST_E2E_PORT ?? "3180");

export default defineConfig({
  testDir: path.resolve(directory, "../browser/frontend/e2e"),
  testMatch: "production-distributed.spec.ts",
  globalSetup: path.join(directory, "setup-distributed-react.mjs"),
  metadata: { conformance: { root: path.resolve(directory, "../.."), port } },
  outputDir: path.join(directory, "test-results/react-distributed-production"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
