import http from "node:http";
import { test, expect, ready, uniqueRun } from "./support";

test("raw SSR renders the selected route and preserves query, cookie and configured authorization", async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: { Authorization: "Bearer conformance-forward" } });
  await context.addCookies([{ name: "fixture_session", value: "conformance-cookie", url: baseURL! }]);
  try {
    const page = await context.newPage();
    const response = await page.goto(`${baseURL}/contract/42?run=${uniqueRun(info)}&tag=one&tag=two&search=space%20value`);
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-type"]).toContain("text/html");
    expect(await response!.text()).toContain("Contract page");
    // The JavaScript-disabled browser parses real SSR markup. Do not strip
    // HTML with a regular expression to concatenate framework text markers.
    await expect(page.getByTestId("contract-page").locator("h1")).toHaveText("Contract page 42");
    await expect(page.getByTestId("contract-page")).toHaveAttribute("data-hydrated", "false");
    const payload = JSON.parse((await page.getByTestId("contract-context").textContent())!);
    expect(payload).toMatchObject({ number: 42, cookie: "conformance-cookie", authorization: "Bearer conformance-forward" });
    expect(payload.query.tag).toEqual(["one", "two"]);
    expect(payload.query.search).toEqual(["space value"]);
  } finally { await context.close(); }
});

test("hydrates the same initial envelope and versions without refetching blocking resources", async ({ page }, info) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", request => { if (request.headers()["x-fluxfast"] === "1") requests.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/contract/0?run=${uniqueRun(info)}`);
  await ready(page);
  await expect(page.getByTestId("contract-page")).toHaveAttribute("data-hydrated", "true");
  const initial = await page.evaluate(() => {
    const bridge = window.fluxAdapterConformance!;
    return { envelope: bridge.initialEnvelope()!, records: bridge.records(), versions: bridge.knownVersions(), page: bridge.page() };
  });
  expect(initial.page.url).toBe(initial.envelope.page.url);
  expect(initial.page.component).toBe(initial.envelope.page.component);
  for (const [key, resource] of Object.entries(initial.envelope.resources)) {
    expect(initial.versions[key]).toBe(resource.version);
    expect(initial.records.find(record => record.key === key)).toMatchObject({ version: resource.version, status: "ready", stale: false });
    expect((await page.evaluate(key => window.fluxAdapterConformance!.resource(key), key)).data).toEqual(resource.value);
  }
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("hard navigation to an unknown route returns an actual HTTP 404", async ({ request }) => {
  const response = await request.get("/contract-route-that-does-not-exist");
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("text/html");
});

test("an internal backend canonical redirect still produces meaningful SSR", async ({ request }) => {
  const response = await request.get("/contract-canonical");
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("Garden Suite");
});

test("SSR rejects an external backend redirect without contacting the other origin", async ({ request }) => {
  let contacted = 0;
  const trap = http.createServer((_request, response) => { contacted += 1; response.end("forbidden destination"); });
  await new Promise<void>(resolve => trap.listen(0, "127.0.0.1", resolve));
  const address = trap.address() as { port: number };
  try {
    const response = await request.get(`/contract-external-redirect?target=${encodeURIComponent(`http://127.0.0.1:${address.port}/forbidden`)}`, { maxRedirects: 0 });
    expect(response.status()).toBe(500);
    expect(response.headers().location).toBeUndefined();
    expect(contacted).toBe(0);
  } finally { await new Promise<void>(resolve => trap.close(() => resolve())); }
});
