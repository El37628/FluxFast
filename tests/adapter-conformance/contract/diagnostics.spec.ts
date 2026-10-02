import { test, expect, ready, production, uniqueRun } from "./support";

test("adapter exposes value-free SSR, navigation, resource, cache, mutation, deferred and live diagnostics", async ({ page }, info) => {
  test.skip(production, "diagnostic traces are development-only");
  test.setTimeout(90_000);
  await page.goto("/");
  await ready(page);
  const timeline = () => page.evaluate(() => window.fluxAdapterConformance!.diagnostics());
  await expect.poll(async () => (await timeline()).some(event => event.type === "server-trace" && (event.data as { source?: string }).source === "ssr")).toBe(true);
  await page.getByRole("link", { name: "Manage rooms" }).click();
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  await page.getByLabel("Room name").fill("Conformance Suite");
  await page.getByRole("button", { name: "Add room" }).click();
  await expect(page.getByRole("status")).toHaveText("Room added");
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("link", { name: "View deferred dashboard" }).click();
  await expect(page.getByTestId("analytics-value")).toBeVisible();
  await page.getByRole("link", { name: "Back to control center" }).click();
  const liveUrl = `/live?run=${uniqueRun(info)}&tenant=tenant-a&user=user-a`;
  await page.evaluate(url => window.fluxAdapterConformance!.visit(url, { usePrefetch: false }), liveUrl);
  await expect(page.getByTestId("live-status")).toHaveText("connected");
  await expect(page.getByTestId("live-deferred-value")).toBeVisible();
  await page.getByRole("button", { name: "Increment tenant counter" }).click();
  await expect(page.getByTestId("live-counter-value")).toHaveText("1");
  const events = await timeline();
  for (const type of ["server-trace", "navigation", "resource-load", "resource-update", "page-cache", "mutation", "deferred", "live"]) {
    expect(events.some(event => event.type === type), `missing ${type} diagnostics`).toBe(true);
  }
  expect(JSON.stringify(events)).not.toContain("Conformance Suite");
  expect(events.filter(event => event.type === "mutation").every(event => event.correlationId)).toBe(true);
});
