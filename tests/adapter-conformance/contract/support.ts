import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { FluxConformanceBridge } from "../harness";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => { window.fluxConformanceEnabled = true; });
    await use(page);
  },
});
export { expect };
export const production = process.env.FLUXFAST_E2E_PRODUCTION === "1";
export const fluxHeaders = { "X-FluxFast": "1", "X-FluxFast-Protocol": "1" };
export function uniqueRun(info: TestInfo) { return `${info.workerIndex}-${info.retry}-${randomUUID()}`; }
export async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(window.fluxAdapterConformance))).toBe(true);
}
export async function inspectResource(page: Page, key: string) {
  return page.evaluate(key => window.fluxAdapterConformance!.resource(key), key);
}
export async function visit(page: Page, url: string, options?: Parameters<FluxConformanceBridge["visit"]>[1]) {
  await page.evaluate(({ url, options }) => window.fluxAdapterConformance!.visit(url, options), { url, options });
}
