import { expect, test, type Page } from "@playwright/test";

const production = process.env.FLUXFAST_E2E_PRODUCTION === "1";

function devtools(page: Page) {
  return page.locator("[data-fluxfast-devtools-host]");
}

function panel(page: Page) {
  return devtools(page).locator("#fluxfast-devtools-panel");
}

async function openDevtools(page: Page): Promise<void> {
  const bar = devtools(page).locator(".ff-bar");
  await expect(bar).toBeVisible();
  if (await panel(page).count() === 0) await bar.click();
  await expect(panel(page)).toBeVisible();
}

async function closeDevtools(page: Page): Promise<void> {
  if (await panel(page).count() === 0) return;
  await devtools(page).getByRole("button", {
    name: "Collapse FluxFast DevTools",
  }).click();
  await expect(panel(page)).toHaveCount(0);
}

test.describe("development DevTools", () => {
  test.skip(production, "development-only behavior");

  test("observes SSR, navigation, cache, deferred, mutation, and live work", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
    await openDevtools(page);

    await devtools(page).getByRole("tab", { name: "Protocol" }).click();
    await expect(panel(page)).toContainText("fluxfast-devtools/1");
    await expect(panel(page)).toContainText("SSR");

    await page.getByRole("link", { name: "Manage rooms" }).click();
    await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
    await devtools(page).getByRole("tab", { name: "Resources" }).click();
    await expect(panel(page).getByRole("table")).toContainText("application");
    await expect(panel(page).getByRole("table")).toContainText("rooms");

    await devtools(page).getByRole("tab", { name: "Cache" }).click();
    await expect(panel(page)).toContainText("Server resource cache");
    await expect(panel(page)).toContainText("Hit ratio1 / 1");
    await expect(panel(page)).toContainText("applicationKNOWN");
    await expect(panel(page)).toContainText("Misses1");

    await page.getByLabel("Room name").fill("DevTools Suite");
    await page.getByRole("button", { name: "Add room" }).click();
    await expect(page.getByRole("status")).toHaveText("Room added");
    await devtools(page).getByRole("tab", { name: "Mutations" }).click();
    await expect(panel(page)).toContainText("Recent mutations");
    await expect(panel(page)).toContainText("POST /rooms");
    await expect(panel(page)).toContainText("append-item ×1");

    await closeDevtools(page);
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
    await page.getByRole("link", { name: "View deferred dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Deferred dashboard" })).toBeVisible();
    await expect(page.getByTestId("analytics-value")).toBeVisible();
    await openDevtools(page);
    await devtools(page).getByRole("tab", { name: "Timeline" }).click();
    await expect(panel(page)).toContainText("DEFERRED");

    await closeDevtools(page);
    await page.getByRole("link", { name: "Back to control center" }).click();
    await page.getByRole("link", { name: "View live dashboard" }).click();
    await expect(page.getByTestId("live-status")).toHaveText("connected");
    await page.getByRole("button", { name: "Increment tenant counter" }).click();
    await expect(page.getByTestId("live-counter-value")).toHaveText("1");
    await openDevtools(page);
    await devtools(page).getByRole("tab", { name: "Live" }).click();
    await expect(panel(page)).toContainText("Live timeline");
    await expect(panel(page)).toContainText("CONNECTED");
    await expect(panel(page)).toContainText("INVALIDATEself-originated");

    await devtools(page).getByRole("tab", { name: "Timeline" }).click();
    const mutationFilter = panel(page).getByRole("button", { name: "mutation", exact: true });
    await mutationFilter.click();
    await expect(mutationFilter).toHaveAttribute("aria-pressed", "true");
    await expect(panel(page)).toContainText(/Showing [1-9]\d* of/);
    await panel(page).getByRole("button", { name: "Clear" }).click();
    await expect(panel(page)).toContainText("No diagnostic events recorded yet.");
    expect(errors).toEqual([]);
  });

  test("StrictMode retains one host and one effective keyboard listener", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const active = new Map<EventListenerOrEventListenerObject, Set<boolean>>();
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      const capture = (options?: boolean | EventListenerOptions) => (
        typeof options === "boolean" ? options : options?.capture ?? false
      );
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions) => {
        if (type === "keydown") {
          const captures = active.get(listener) ?? new Set<boolean>();
          captures.add(capture(options));
          active.set(listener, captures);
        }
        add(type, listener, options);
      }) as typeof window.addEventListener;
      window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions) => {
        if (type === "keydown") {
          const captures = active.get(listener);
          captures?.delete(capture(options));
          if (captures?.size === 0) active.delete(listener);
        }
        remove(type, listener, options);
      }) as typeof window.removeEventListener;
      (window as unknown as { devtoolsKeydownListeners: () => number })
        .devtoolsKeydownListeners = () => [...active.values()]
          .reduce((total, captures) => total + captures.size, 0);
    });
    const listenerCount = () => page.evaluate(() => (
      (window as unknown as { devtoolsKeydownListeners: () => number })
        .devtoolsKeydownListeners()
    ));

    await page.goto("/");
    await expect(devtools(page)).toHaveCount(1);
    await expect.poll(listenerCount).toBeGreaterThan(0);
    const initialListenerCount = await listenerCount();
    const bar = devtools(page).locator(".ff-bar");
    await expect(bar).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Alt+Shift+D");
    await expect(bar).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Alt+Shift+D");
    await expect(bar).toHaveAttribute("aria-expanded", "false");

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.getByRole("link", { name: "Manage rooms" }).click();
      await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
      await page.getByRole("button", { name: "Finish" }).click();
      await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
      await expect(devtools(page)).toHaveCount(1);
      await expect.poll(listenerCount).toBe(initialListenerCount);
    }
  });
});

test.describe("production DevTools exclusion", () => {
  test.skip(!production, "production-only behavior");

  test("has no UI, browser opt-in header, trace response, or serialized timeline", async ({
    page,
  }) => {
    const devtoolsHeaders: string[] = [];
    page.on("request", request => {
      const value = request.headers()["x-fluxfast-devtools"];
      if (value !== undefined) devtoolsHeaders.push(value);
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
    await page.getByRole("link", { name: "Manage rooms" }).click();
    await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
    await expect(devtools(page)).toHaveCount(0);
    expect(devtoolsHeaders).toEqual([]);

    const forced = await page.request.get("/rooms", {
      headers: {
        "X-FluxFast": "1",
        "X-FluxFast-Protocol": "1",
        "X-FluxFast-DevTools": "1",
      },
    });
    expect(forced.status()).toBe(200);
    expect(forced.headers()["x-fluxfast-devtools-trace"]).toBeUndefined();
    const html = await page.locator("html").evaluate(element => element.innerHTML);
    expect(html).not.toContain("data-fluxfast-devtools-host");
    expect(html).not.toContain("fluxfast-devtools/1");
    expect(html).not.toContain("diagnostic event timeline");
  });
});
