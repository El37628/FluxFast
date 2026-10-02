import { test, expect, production, fluxHeaders } from "./support";

test("production omits DevTools UI, opt-in headers, SSR traces and serialized timelines", async ({ page }) => {
  test.skip(!production, "production artifact contract");
  const optIns: string[] = [];
  page.on("request", request => {
    const optIn = request.headers()["x-fluxfast-devtools"];
    if (optIn !== undefined) optIns.push(optIn);
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Manage rooms" }).click();
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  await expect(page.locator("[data-fluxfast-devtools-host]")).toHaveCount(0);
  expect(optIns).toEqual([]);
  const forced = await page.request.get("/rooms", { headers: { ...fluxHeaders, "X-FluxFast-DevTools": "1" } });
  expect(forced.status()).toBe(200);
  expect(forced.headers()["x-fluxfast-devtools-trace"]).toBeUndefined();
  const html = await page.locator("html").evaluate(element => element.innerHTML);
  expect(html).not.toContain("data-fluxfast-devtools-host");
  expect(html).not.toContain("fluxfast-devtools/1");
  expect(html).not.toContain("diagnostic event timeline");
});

test("non-Flux backend endpoints fail closed instead of rendering their payload as public document pages", async ({ request }) => {
  test.skip(!production, "production topology contract");
  for (const pathname of ["/openapi.json", "/docs", "/redoc"]) {
    const response = await request.get(pathname);
    // These exist in FastAPI but are not FluxFast pages. Rejecting a malformed
    // initial envelope may be 500; actual unknown Flux page 404 is tested separately.
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.headers()["content-type"]).toContain("text/html");
    const html = await response.text();
    expect(html).not.toContain('"openapi":');
    expect(html).not.toContain("SwaggerUIBundle");
    expect(html).not.toContain("redoc.standalone");
  }
});
