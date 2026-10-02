import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./harnesses/index.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const options = { root: path.resolve(directory, "../..") };

export default defineConfig({
  testDir: path.join(directory, "contract"),
  globalSetup: path.join(directory, "setup.mjs"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  metadata: { conformance: options },
  use: { baseURL: createHarness(undefined, options).baseUrl, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
