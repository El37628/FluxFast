import { expect, test, type Page, type TestInfo } from "@playwright/test";

function uniqueRun(testInfo: TestInfo): string {
  return `${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
}

function distributedUrl(run: string, client: "a" | "b"): string {
  const query = new URLSearchParams({ run, client });
  return `/distributed-live?${query.toString()}`;
}

async function waitForLive(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Distributed live dashboard" })
  ).toBeVisible();
  await expect(page.getByTestId("distributed-live-status")).toHaveText(
    "connected"
  );
}

test("two browsers converge across three Redis-backed workers", async ({
  browser,
  request,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const errors: string[] = [];
  for (const page of [first, second]) {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
  }

  try {
    await first.goto(distributedUrl(run, "a"));
    await waitForLive(first);
    await expect(first.getByTestId("distributed-counter-value")).toHaveText("0");

    await second.goto(distributedUrl(run, "b"));
    await waitForLive(second);
    await expect(second.getByTestId("distributed-counter-value")).toHaveText("0");

    const warmDiagnostics = await request.get(
      `/distributed-live/diagnostics?run=${encodeURIComponent(run)}`,
      { headers: { "X-FluxFast": "1" } }
    );
    expect(warmDiagnostics.ok()).toBe(true);
    const warm = await warmDiagnostics.json();
    expect(warm.records["loader:a"]).toHaveLength(1);
    expect(warm.records["loader:b"]).toEqual([]);

    await first.getByRole("button", {
      name: "Increment distributed counter",
    }).click();
    await Promise.all([
      expect(first.getByTestId("distributed-counter-value")).toHaveText("1"),
      expect(second.getByTestId("distributed-counter-value")).toHaveText("1"),
    ]);

    const diagnosticsResponse = await request.get(
      `/distributed-live/diagnostics?run=${encodeURIComponent(run)}`,
      { headers: { "X-FluxFast": "1" } }
    );
    expect(diagnosticsResponse.ok()).toBe(true);
    const diagnostics = await diagnosticsResponse.json();
    const records = diagnostics.records as Record<string, string[]>;
    expect(diagnostics.state).toBe(1);
    for (const role of [
      "page:a",
      "page:b",
      "stream:a",
      "stream:b",
      "refresh:a",
      "refresh:b",
      "mutation",
    ]) {
      expect(records[role], role).toHaveLength(1);
    }
    expect(records["page:a"][0]).toMatch(/^A:\d+$/);
    expect(records["stream:a"][0]).toMatch(/^A:\d+$/);
    expect(records["refresh:a"][0]).toMatch(/^A:\d+$/);
    expect(records["page:b"][0]).toMatch(/^B:\d+$/);
    expect(records["stream:b"][0]).toMatch(/^B:\d+$/);
    expect(records["refresh:b"][0]).toMatch(/^B:\d+$/);
    expect(records.mutation[0]).toMatch(/^C:\d+$/);
    expect(
      new Set([
        records["page:a"][0],
        records["page:b"][0],
        records.mutation[0],
      ]).size
    ).toBe(3);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(
      `/distributed-live/diagnostics?run=${encodeURIComponent(run)}`,
      { headers: { "X-FluxFast": "1" } }
    );
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
