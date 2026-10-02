import { test, expect, ready, inspectResource } from "./support";

test("deferred declarations seed pending state and one follow-up without changing page identity", async ({ page }) => {
  const responses: string[] = [];
  page.on("request", request => {
    const only = request.headers()["x-fluxfast-only"];
    if (only) responses.push(only);
  });
  await page.goto("/deferred");
  await ready(page);
  const initial = await page.evaluate(() => window.fluxAdapterConformance!.initialEnvelope()!);
  expect(initial.deferred?.sort()).toEqual(["activity", "analytics"]);
  expect(initial.resources.analytics).toBeUndefined();
  expect(initial.resources.activity).toBeUndefined();
  const pageState = await page.evaluate(() => window.fluxAdapterConformance!.page());
  await expect(page.getByTestId("analytics-value")).toBeVisible();
  expect((await inspectResource(page, "analytics")).status).toBe("ready");
  expect(await page.evaluate(() => window.fluxAdapterConformance!.page())).toEqual(pageState);
  expect(responses).toHaveLength(1);
});

test("late deferred responses are suppressed even when a transport ignores abort", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/deferred-race") && options?.headers && new Headers(options.headers).has("x-fluxfast-only")) {
        return original(input, { ...options, signal: undefined });
      }
      return original(input, options);
    };
  });
  const started = page.waitForRequest(request => request.headers()["x-fluxfast-only"] === "race-analytics");
  const settled = page.waitForEvent("requestfinished", request => request.headers()["x-fluxfast-only"] === "race-analytics");
  await page.goto("/deferred-race");
  await started;
  await ready(page);
  await page.getByRole("link", { name: "Leave for rooms" }).click();
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  await settled;
  expect((await inspectResource(page, "race-analytics")).data).toBeUndefined();
  await expect(page.getByTestId("race-analytics-value")).toHaveCount(0);
});
