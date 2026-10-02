import { test, expect, ready, uniqueRun } from "./support";
import type { Request } from "@playwright/test";

test("initial hydration keeps one successful live stream and one deferred batch", async ({ page }, info) => {
  const activeStreams = new Set<Request>();
  let successfulStreams = 0;
  const deferredBatches: string[] = [];
  page.on("request", request => {
    if (request.headers()["x-fluxfast-live"] === "1") activeStreams.add(request);
    const only = request.headers()["x-fluxfast-only"];
    if (only) deferredBatches.push(only);
  });
  page.on("response", response => {
    if (response.request().headers()["x-fluxfast-live"] === "1" && response.ok()) successfulStreams += 1;
  });
  page.on("requestfinished", request => activeStreams.delete(request));
  page.on("requestfailed", request => activeStreams.delete(request));
  await page.goto(`/live?run=${uniqueRun(info)}&tenant=tenant-a&user=user-a`);
  await ready(page);
  await expect(page.getByTestId("live-status")).toHaveText("connected");
  await expect(page.getByTestId("live-deferred-value")).toHaveText("0");
  const initial = await page.evaluate(() => window.fluxAdapterConformance!.initialEnvelope()!);
  expect(initial.deferred).toEqual(["live-deferred"]);
  expect(initial.resources["live-deferred"]).toBeUndefined();
  expect(initial.live).toBeDefined();
  await expect.poll(() => activeStreams.size).toBe(1);
  expect(successfulStreams).toBe(1);
  expect(deferredBatches).toEqual(["live-deferred"]);
});
