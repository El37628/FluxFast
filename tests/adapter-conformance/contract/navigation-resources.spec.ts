import { test, expect, ready, uniqueRun, visit, inspectResource, fluxHeaders } from "./support";

test("shared resources retain their versions when a link delta omits known records", async ({ page }, info) => {
  await page.goto(`/contract/0?run=${uniqueRun(info)}`);
  await ready(page);
  const version = await page.evaluate(() => window.fluxAdapterConformance!.knownVersions()["contract-shared"]);
  const responsePromise = page.waitForResponse(response => response.request().headers()["x-fluxfast"] === "1" && new URL(response.url()).pathname === "/contract/1");
  await page.getByRole("link", { name: "Next contract page" }).click();
  const response = await responsePromise;
  expect(JSON.parse(Buffer.from(response.request().headers()["x-fluxfast-known"], "base64url").toString())["contract-shared"]).toBe(version);
  const envelope = await response.json();
  expect(envelope.resourceKeys).toContain("contract-shared");
  expect(envelope.resources["contract-shared"]).toBeUndefined();
  await expect(page.getByRole("heading", { name: "Contract page 1" })).toBeVisible();
  await expect(page.getByTestId("contract-shared")).toHaveText("shared");
  expect(await page.evaluate(() => window.fluxAdapterConformance!.knownVersions()["contract-shared"])).toBe(version);
});

test("router visits support replace, preserveScroll, Back and Forward without document reloads", async ({ page }, info) => {
  const run = uniqueRun(info);
  let documents = 0;
  page.on("request", request => { if (request.resourceType() === "document") documents += 1; });
  await page.goto(`/contract/0?run=${run}`);
  await ready(page);
  await page.evaluate(() => window.scrollTo(0, 800));
  await visit(page, `/contract/1?run=${run}`, { preserveScroll: true, usePrefetch: false });
  expect(await page.evaluate(() => window.scrollY)).toBe(800);
  await visit(page, `/contract/2?run=${run}`, { replace: true, usePrefetch: false });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/contract/0\\?run=${run}$`));
  await expect(page.getByRole("heading", { name: "Contract page 0" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Contract page 2" })).toBeVisible();
  expect(documents).toBe(1);
});

test("a completed prefetch is consumed by navigation instead of fetching twice", async ({ page }, info) => {
  const run = uniqueRun(info);
  const requests: string[] = [];
  page.on("request", request => { if (request.headers()["x-fluxfast"] === "1") requests.push(request.url()); });
  await page.goto(`/contract/0?run=${run}`);
  await ready(page);
  const target = `/contract/1?run=${run}`;
  await page.evaluate(url => window.fluxAdapterConformance!.prefetch(url), target);
  await visit(page, target);
  await expect(page.getByRole("heading", { name: "Contract page 1" })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test("history uses retained page-cache entries and fetches an LRU-evicted entry", async ({ page }) => {
  let requests = 0;
  page.on("request", request => { if (request.headers()["x-fluxfast"] === "1") requests += 1; });
  await page.goto("/contract-cache/0");
  await ready(page);
  for (let index = 1; index <= 8; index += 1) await visit(page, `/contract-cache/${index}`, { usePrefetch: false });
  const before = requests;
  await page.evaluate(() => window.history.go(-7));
  // Hosts may retain hidden page DOM during history restoration. Assert the
  // accessible page and the active runtime, not an arbitrary retained node.
  await expect(page.getByRole("heading", { name: "/contract-cache/1", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.fluxAdapterConformance!.page().url)).toBe("/contract-cache/1");
  expect(requests).toBe(before);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "/contract-cache/0", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.fluxAdapterConformance!.page().url)).toBe("/contract-cache/0");
  expect(requests).toBe(before + 1);
});

test("adapter cache configuration bounds resource LRU and omits evicted known versions", async ({ page }) => {
  await page.goto("/contract-resource-cache/0");
  await ready(page);
  await visit(page, "/contract-resource-cache/1", { usePrefetch: false });
  await visit(page, "/contract-resource-cache/2", { usePrefetch: false });
  const versions = await page.evaluate(() => window.fluxAdapterConformance!.knownVersions());
  expect(Object.keys(versions).sort()).toEqual(["contract-lru-b", "contract-lru-c"]);
  const responsePromise = page.waitForResponse(response => response.request().headers()["x-fluxfast"] === "1" && new URL(response.url()).pathname === "/contract-resource-cache/0");
  await visit(page, "/contract-resource-cache/0", { usePrefetch: false });
  const response = await responsePromise;
  const known = JSON.parse(Buffer.from(response.request().headers()["x-fluxfast-known"], "base64url").toString());
  expect(known["contract-lru-a"]).toBeUndefined();
  expect((await response.json()).resources["contract-lru-a"].value).toEqual({ value: 0, label: "LRU" });
});

test("only refresh preserves the page and unrelated resources, then error state can retry", async ({ page }, info) => {
  const run = uniqueRun(info);
  const url = `/contract/0?run=${run}`;
  await page.goto(url);
  await ready(page);
  const initial = await page.evaluate(() => ({ page: window.fluxAdapterConformance!.page(), items: window.fluxAdapterConformance!.resource("contract-items") }));
  await page.request.post(`/contract-control/${run}`, { headers: fluxHeaders, data: { fail: false, value: 5 } });
  const responsePromise = page.waitForResponse(response => response.request().headers()["x-fluxfast-only"] === "contract-counter");
  await page.getByRole("button", { name: "Refresh counter" }).click();
  const response = await responsePromise;
  expect(Object.keys((await response.json()).resources)).toEqual(["contract-counter"]);
  expect(await page.evaluate(() => window.fluxAdapterConformance!.page())).toEqual(initial.page);
  expect(await inspectResource(page, "contract-items")).toEqual(initial.items);
  await page.request.post(`/contract-control/${run}`, { headers: fluxHeaders, data: { fail: true } });
  await page.getByRole("button", { name: "Refresh counter" }).click();
  await expect(page.getByTestId("contract-counter-status")).toHaveText("error");
  await expect(page.getByTestId("contract-page").getByRole("alert")).toBeVisible();
  await page.request.post(`/contract-control/${run}`, { headers: fluxHeaders, data: { fail: false } });
  await page.getByRole("button", { name: "Retry counter" }).click();
  await expect(page.getByTestId("contract-counter-status")).toHaveText("ready");
  await expect(page.getByTestId("contract-page").getByRole("alert")).toHaveCount(0);
  expect((await inspectResource(page, "contract-counter")).data).toEqual({ value: 5, label: "initial" });
  expect(await page.evaluate(() => window.fluxAdapterConformance!.page())).toEqual(initial.page);
});
