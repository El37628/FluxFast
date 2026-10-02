import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./harnesses/index.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const options = { root: path.resolve(directory, "../..") };
const harness = createHarness(undefined, options);
const mode = process.env.FLUXFAST_E2E_PRODUCTION === "1" ? "production" : "development";

export default defineConfig({
  testDir: path.join(directory, "contract"),
  outputDir: process.env.FLUXFAST_CONFORMANCE_OUTPUT_DIR ?? path.join(directory, "test-results", `${harness.name}-${mode}`),
  globalSetup: path.join(directory, "setup.mjs"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  metadata: { conformance: options },
  use: { baseURL: harness.baseUrl, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
