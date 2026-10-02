import { test, expect, ready, uniqueRun, inspectResource } from "./support";

const operations = [
  { action: "replace", key: "contract-counter", operation: "replace-resource", value: { value: 10, label: "changed" } },
  { action: "merge", key: "contract-counter", operation: "merge-object", value: { value: 0, label: "changed" } },
  { action: "replace-item", key: "contract-items", operation: "replace-item", value: [{ id: 1, name: "changed" }, { id: 2, name: "two" }] },
  { action: "remove-item", key: "contract-items", operation: "remove-item", value: [{ id: 1, name: "one" }] },
  { action: "append", key: "contract-items", operation: "append-item", value: [{ id: 1, name: "one" }, { id: 2, name: "two" }, { id: 3, name: "changed" }] },
];

for (const operation of operations) {
  test(`mutation reconciles ${operation.operation} into subscribed UI`, async ({ page }, info) => {
    const run = uniqueRun(info);
    await page.goto(`/contract/0?run=${run}`);
    await ready(page);
    const envelope = await page.evaluate(body => window.fluxAdapterConformance!.mutate("/contract-action", body), { run, action: operation.action, label: "changed" });
    expect(envelope.mutation.patches![operation.key][0].op).toBe(operation.operation);
    expect((await inspectResource(page, operation.key)).data).toEqual(operation.value);
    if (operation.key === "contract-counter") {
      await expect(page.getByTestId("contract-counter")).toHaveText(JSON.stringify(operation.value));
    } else {
      await expect(page.getByRole("list", { name: "Contract items" }).getByRole("listitem")).toHaveText((operation.value as Array<{ name: string }>).map(item => item.name));
    }
  });
}

test("authoritative 422 validation does not change resources or page state", async ({ page }, info) => {
  const run = uniqueRun(info);
  await page.goto(`/contract/0?run=${run}`);
  await ready(page);
  const initial = await inspectResource(page, "contract-counter");
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/contract-action");
  const error = await page.evaluate(async run => {
    try { await window.fluxAdapterConformance!.mutate("/contract-action", { run, action: "replace", label: "x" }); }
    catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
  }, run);
  expect((await responsePromise).status()).toBe(422);
  expect(error?.name).toBe("ValidationError");
  expect(await inspectResource(page, "contract-counter")).toEqual(initial);
  await expect(page.getByRole("heading", { name: "Contract page 0" })).toBeVisible();
});

test("invalidation renders stale data during canonical refresh and settles the fresh value", async ({ page }, info) => {
  const run = uniqueRun(info);
  await page.goto(`/contract/0?run=${run}`);
  await ready(page);
  let releaseRefresh!: () => void;
  const held = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route("**/contract/0?*", async route => {
    if (route.request().headers()["x-fluxfast-only"] !== "contract-counter") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    // Hold the real canonical response until the stale UI is observed. This
    // verifies the transition without depending on a short wall-clock window.
    await held;
    await route.fulfill({ response });
  });
  const refreshPromise = page.waitForResponse(response => response.request().headers()["x-fluxfast-only"] === "contract-counter");
  const completion = page.evaluate(body => window.fluxAdapterConformance!.mutate("/contract-action", body), { run, action: "invalidate", label: "changed" });
  try {
    await expect(page.getByTestId("contract-counter-stale")).toHaveText("true");
    await expect(page.getByTestId("contract-counter")).toContainText('"value":0');
  } finally { releaseRefresh(); }
  await completion;
  const refresh = await refreshPromise;
  const known = JSON.parse(Buffer.from(refresh.request().headers()["x-fluxfast-known"], "base64url").toString());
  expect(known["contract-counter"]).toBeUndefined();
  await expect(page.getByTestId("contract-counter-stale")).toHaveText("false");
  await expect(page.getByTestId("contract-counter")).toContainText('"value":1');
});

test("a mutation internal redirect is a hydrated navigation", async ({ page }, info) => {
  const run = uniqueRun(info);
  let documents = 0;
  page.on("request", request => { if (request.resourceType() === "document") documents += 1; });
  await page.goto(`/contract/0?run=${run}`);
  await ready(page);
  const envelope = await page.evaluate(body => window.fluxAdapterConformance!.mutate("/contract-action", body), { run, action: "internal", label: "changed" });
  expect(envelope.mutation.redirect).toBe(`/contract/1?run=${run}`);
  await expect(page.getByRole("heading", { name: "Contract page 1" })).toBeVisible();
  expect(documents).toBe(1);
});

test("an explicit mutation external redirect performs a full document navigation", async ({ page }, info) => {
  const run = uniqueRun(info);
  const destination = "https://outside.fluxfast.invalid/landing";
  let observedRedirect: string | undefined;
  await page.route(destination, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><h1>External destination</h1>" }));
  await page.route("**/contract-action", async route => {
    // Read the real backend response before delivering it to the browser:
    // document navigation can discard the old document's network body.
    const response = await route.fetch();
    observedRedirect = (await response.json()).mutation.externalRedirect;
    await route.fulfill({ response });
  });
  await page.goto(`/contract/0?run=${run}`);
  await ready(page);
  await page.evaluate(body => { void window.fluxAdapterConformance!.mutate("/contract-action", body); }, { run, action: "external", label: "changed" });
  await expect(page).toHaveURL(destination);
  expect(observedRedirect).toBe(destination);
  await expect(page.getByRole("heading", { name: "External destination" })).toBeVisible();
});
