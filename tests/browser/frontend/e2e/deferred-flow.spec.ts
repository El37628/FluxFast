import { expect, test, type Page } from "@playwright/test";

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function observeResourceBatches(page: Page): string[][] {
  const batches: string[][] = [];
  page.on("request", request => {
    const only = request.headers()["x-fluxfast-only"];
    if (only) batches.push(only.split(",").sort());
  });
  return batches;
}

test("renders the shell before deferred data and isolates a retryable failure", async ({
  page,
}) => {
  const browserErrors = observeBrowserErrors(page);
  const resourceBatches = observeResourceBatches(page);

  await page.goto("/deferred");

  await expect(page.getByRole("heading", { name: "Deferred dashboard" })).toBeVisible();
  await expect(page.getByTestId("analytics-loading")).toBeVisible();
  await expect(page.getByTestId("activity-loading")).toBeVisible();
  await expect.poll(() => resourceBatches.length).toBe(1);

  await expect(page.getByTestId("analytics-value")).toContainText("95000");
  await expect(page.getByTestId("activity-error")).toContainText(
    "A deferred resource could not be resolved"
  );
  expect(resourceBatches).toEqual([["activity", "analytics"]]);

  await page.getByRole("button", { name: "Retry activity" }).click();
  await expect(page.getByTestId("activity-loading")).toBeVisible();
  await expect(page.getByRole("list", { name: "Activity feed" })).toContainText(
    "Activity recovered after retry"
  );
  expect(resourceBatches).toEqual([
    ["activity", "analytics"],
    ["activity"],
  ]);
  expect(browserErrors).toEqual([]);
});

test("restores resolved deferred data from PageCache on Back", async ({ page }, testInfo) => {
  const browserErrors = observeBrowserErrors(page);
  const resourceBatches = observeResourceBatches(page);
  const runId = encodeURIComponent(`${testInfo.retry}-${Date.now()}`);

  await page.goto(`/deferred-cache?run=${runId}`);
  await expect(page.getByTestId("cached-analytics-loading")).toBeVisible();
  await expect(page.getByTestId("cached-analytics-value")).toContainText("101000");
  expect(resourceBatches).toEqual([["cached-analytics"]]);

  await page.getByRole("link", { name: "Manage rooms" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/deferred-cache\?run=/);
  await expect(page.getByTestId("cached-analytics-value")).toContainText("101000");
  await expect(page.getByTestId("cached-analytics-loading")).toHaveCount(0);
  await page.waitForTimeout(700);

  expect(resourceBatches).toEqual([["cached-analytics"]]);
  expect(browserErrors).toEqual([]);
});

test("navigation cancels a deferred response before it can change the new page", async ({
  page,
}) => {
  const browserErrors = observeBrowserErrors(page);
  const resourceBatches = observeResourceBatches(page);

  await page.goto("/deferred-race");
  await expect(page.getByTestId("race-analytics-loading")).toBeVisible();
  await expect.poll(() => resourceBatches.length).toBe(1);

  await page.getByRole("link", { name: "Leave for rooms" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  await page.waitForTimeout(1_400);

  await expect(page.getByTestId("race-analytics-value")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("mutation revalidation keeps stale data until a fresh resource arrives", async ({
  page,
}) => {
  const browserErrors = observeBrowserErrors(page);
  const resourceBatches = observeResourceBatches(page);
  let documentRequests = 0;
  page.on("request", request => {
    if (request.resourceType() === "document") documentRequests += 1;
  });

  await page.goto("/deferred-mutation");
  const value = page.getByTestId("live-analytics-value");
  await expect(value).toBeVisible();
  const previousValue = await value.textContent();

  await page.getByRole("button", { name: "Refresh analytics" }).click();
  await expect(page.getByTestId("live-analytics-refreshing")).toBeVisible();
  await expect(page.getByTestId("live-analytics-stale")).toBeVisible();
  await expect(value).toHaveText(previousValue!);

  await expect(value).not.toHaveText(previousValue!);
  await expect(page.getByTestId("live-analytics-refreshing")).toHaveCount(0);
  await expect(page.getByTestId("live-analytics-stale")).toHaveCount(0);
  await expect(page).toHaveURL(/\/deferred-mutation$/);

  expect(resourceBatches).toEqual([
    ["live-analytics"],
    ["live-analytics"],
  ]);
  expect(documentRequests).toBe(1);
  expect(browserErrors).toEqual([]);
});
