import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

function uniqueRun(testInfo: TestInfo): string {
  return `${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
}

function liveUrl(
  run: string,
  tenant = "tenant-a",
  user = "user-a"
): string {
  const query = new URLSearchParams({ run, tenant, user });
  return `/live?${query.toString()}`;
}

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function observeResourceLoads(page: Page): string[][] {
  const loads: string[][] = [];
  page.on("request", request => {
    const only = request.headers()["x-fluxfast-only"];
    if (only) loads.push(only.split(",").sort());
  });
  return loads;
}

async function waitForLive(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Live dashboard" })).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("connected");
}

async function createLivePair(
  browser: Browser,
  firstUrl: string,
  secondUrl = firstUrl
): Promise<{
  contexts: [BrowserContext, BrowserContext];
  pages: [Page, Page];
}> {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await Promise.all([first.goto(firstUrl), second.goto(secondUrl)]);
  await Promise.all([waitForLive(first), waitForLive(second)]);
  return {
    contexts: [firstContext, secondContext],
    pages: [first, second],
  };
}

async function closeContexts(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(contexts.map(context => context.close()));
}

test("two clients synchronize a scoped resource without reloading", async ({
  browser,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [first, second] } = await createLivePair(
    browser,
    liveUrl(run)
  );
  const firstErrors = observeBrowserErrors(first);
  const secondErrors = observeBrowserErrors(second);
  let secondDocuments = 0;
  second.on("request", request => {
    if (request.resourceType() === "document") secondDocuments += 1;
  });

  try {
    await expect(first.getByTestId("live-counter-value")).toHaveText("0");
    await expect(second.getByTestId("live-counter-value")).toHaveText("0");

    await first.getByRole("button", { name: "Increment tenant counter" }).click();

    await expect(first.getByTestId("live-counter-value")).toHaveText("1");
    await expect(second.getByTestId("live-counter-value")).toHaveText("1");
    expect(secondDocuments).toBe(0);
    expect([...firstErrors, ...secondErrors]).toEqual([]);
  } finally {
    await closeContexts(contexts);
  }
});

test("origin suppression prevents a duplicate canonical refresh", async ({
  browser,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [origin, peer] } = await createLivePair(
    browser,
    liveUrl(run)
  );
  const originLoads = observeResourceLoads(origin);
  const peerLoads = observeResourceLoads(peer);

  try {
    await Promise.all([
      expect(origin.getByTestId("live-deferred-value")).toHaveText("0"),
      expect(peer.getByTestId("live-deferred-value")).toHaveText("0"),
    ]);
    originLoads.length = 0;
    peerLoads.length = 0;

    await origin.getByRole("button", { name: "Increment tenant counter" }).click();
    await expect(origin.getByTestId("live-counter-value")).toHaveText("1");
    await expect(peer.getByTestId("live-counter-value")).toHaveText("1");
    await expect.poll(
      () => originLoads.filter(keys => keys.includes("live-counter")).length
    ).toBe(1);
    await expect.poll(
      () => peerLoads.filter(keys => keys.includes("live-counter")).length
    ).toBe(1);
    await origin.waitForTimeout(400);
    expect(originLoads.filter(keys => keys.includes("live-counter"))).toHaveLength(1);
    expect(peerLoads.filter(keys => keys.includes("live-counter"))).toHaveLength(1);
  } finally {
    await closeContexts(contexts);
  }
});

test("tenant events never cross tenant scope", async ({ browser }, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [tenantA, tenantB] } = await createLivePair(
    browser,
    liveUrl(run, "tenant-a"),
    liveUrl(run, "tenant-b")
  );
  const tenantBLoads = observeResourceLoads(tenantB);

  try {
    tenantBLoads.length = 0;
    await tenantA.getByRole("button", { name: "Increment tenant counter" }).click();
    await expect(tenantA.getByTestId("live-counter-value")).toHaveText("1");
    await tenantB.waitForTimeout(500);
    await expect(tenantB.getByTestId("live-counter-value")).toHaveText("0");
    expect(tenantBLoads.filter(keys => keys.includes("live-counter"))).toEqual([]);
  } finally {
    await closeContexts(contexts);
  }
});

test("user events never cross user scope", async ({ browser }, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [alice, bob] } = await createLivePair(
    browser,
    liveUrl(run, "shared", "alice"),
    liveUrl(run, "shared", "bob")
  );
  const bobLoads = observeResourceLoads(bob);

  try {
    bobLoads.length = 0;
    await alice.getByRole("button", { name: "Add user notification" }).click();
    await expect(alice.getByTestId("live-notification-value")).toHaveText("1");
    await bob.waitForTimeout(500);
    await expect(bob.getByTestId("live-notification-value")).toHaveText("0");
    expect(
      bobLoads.filter(keys => keys.includes("live-notifications"))
    ).toEqual([]);
  } finally {
    await closeContexts(contexts);
  }
});

test("navigation aborts the old stream and ignores old resource updates", async ({
  browser,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [active, leaving] } = await createLivePair(
    browser,
    liveUrl(run)
  );
  const leavingLoads = observeResourceLoads(leaving);
  let endedStreams = 0;
  const countEndedStream = (request: { headers(): Record<string, string> }) => {
    if (request.headers()["x-fluxfast-live"] === "1") endedStreams += 1;
  };
  leaving.on("requestfinished", countEndedStream);
  leaving.on("requestfailed", countEndedStream);

  try {
    await leaving.getByRole("link", { name: "Leave live dashboard" }).click();
    await expect(leaving).toHaveURL(/\/rooms$/);
    await expect(leaving.getByRole("heading", { name: "Rooms" })).toBeVisible();
    await expect.poll(() => endedStreams).toBeGreaterThanOrEqual(1);
    leavingLoads.length = 0;

    await active.getByRole("button", { name: "Increment tenant counter" }).click();
    await expect(active.getByTestId("live-counter-value")).toHaveText("1");
    await leaving.waitForTimeout(500);
    await expect(leaving.getByTestId("live-counter-value")).toHaveCount(0);
    expect(leavingLoads.filter(keys => keys.includes("live-counter"))).toEqual([]);
  } finally {
    await closeContexts(contexts);
  }
});

test("offline reconnect performs canonical resynchronization", async ({
  browser,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [active, reconnecting] } = await createLivePair(
    browser,
    liveUrl(run)
  );

  try {
    await contexts[1].setOffline(true);
    await expect(reconnecting.getByTestId("live-status")).toHaveText("offline");

    await active.getByRole("button", { name: "Increment tenant counter" }).click();
    await expect(active.getByTestId("live-counter-value")).toHaveText("1");
    await expect(reconnecting.getByTestId("live-counter-value")).toHaveText("0");

    await contexts[1].setOffline(false);
    await expect(reconnecting.getByTestId("live-status")).toHaveText("connected");
    await expect(reconnecting.getByTestId("live-counter-value")).toHaveText("1");
  } finally {
    await closeContexts(contexts);
  }
});

test("a deferred live resource progresses from pending to ready to updated", async ({
  browser,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  try {
    await Promise.all([first.goto(liveUrl(run)), second.goto(liveUrl(run))]);
    await expect(second.getByTestId("live-deferred-loading")).toBeVisible();
    await Promise.all([waitForLive(first), waitForLive(second)]);
    await expect(first.getByTestId("live-deferred-value")).toHaveText("0");
    await expect(second.getByTestId("live-deferred-value")).toHaveText("0");

    await first.getByRole("button", { name: "Update deferred live value" }).click();
    await expect(second.getByTestId("live-deferred-stale")).toBeVisible();
    await expect(second.getByTestId("live-deferred-value")).toHaveText("0");
    await expect(second.getByTestId("live-deferred-value")).toHaveText("1");
    await expect(second.getByTestId("live-deferred-stale")).toHaveCount(0);
  } finally {
    await closeContexts([firstContext, secondContext]);
  }
});

test("a live patch renders immediately and then verifies canonical state", async ({
  browser,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [origin, peer] } = await createLivePair(
    browser,
    liveUrl(run)
  );

  try {
    await expect(peer.getByTestId("live-patch-value")).toHaveText("0");
    await origin.getByRole("button", { name: "Publish live patch" }).click();
    await expect(peer.getByTestId("live-patch-value")).toHaveText("1");
    await expect(peer.getByTestId("live-patch-stale")).toBeVisible();
    await expect(peer.getByTestId("live-patch-stale")).toHaveCount(0);
    await expect(peer.getByTestId("live-patch-value")).toHaveText("1");
  } finally {
    await closeContexts(contexts);
  }
});

test("Back restores the page and restarts its live subscription", async ({
  browser,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const { contexts, pages: [active, history] } = await createLivePair(
    browser,
    liveUrl(run)
  );

  try {
    await history.getByRole("link", { name: "Leave live dashboard" }).click();
    await expect(history).toHaveURL(/\/rooms$/);
    await history.goBack();
    await expect(history).toHaveURL(/\/live\?/);
    await waitForLive(history);

    await active.getByRole("button", { name: "Increment tenant counter" }).click();
    await expect(history.getByTestId("live-counter-value")).toHaveText("1");
  } finally {
    await closeContexts(contexts);
  }
});

test("production build synchronizes two clients through one origin", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.FLUXFAST_E2E_PRODUCTION !== "1",
    "production-only Next build coverage"
  );
  const run = uniqueRun(testInfo);
  const origins = new Set<string>();
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  for (const page of [first, second]) {
    page.on("request", request => {
      if (request.headers()["x-fluxfast"] === "1") {
        origins.add(new URL(request.url()).origin);
      }
    });
  }

  try {
    await Promise.all([first.goto(liveUrl(run)), second.goto(liveUrl(run))]);
    await Promise.all([waitForLive(first), waitForLive(second)]);
    await first.getByRole("button", { name: "Increment tenant counter" }).click();
    await expect(second.getByTestId("live-counter-value")).toHaveText("1");
    expect([...origins]).toEqual([new URL(baseURL!).origin]);
  } finally {
    await closeContexts([firstContext, secondContext]);
  }
});
