import { defineConfig } from "@playwright/test";

const baseURL = process.env.FLUXFAST_COMPOSE_BASE_URL;
if (!baseURL) {
  throw new Error("FLUXFAST_COMPOSE_BASE_URL is required");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "production-distributed.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
