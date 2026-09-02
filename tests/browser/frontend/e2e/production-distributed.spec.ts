import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

interface Diagnostics {
  records: Record<string, string[]>;
  state: number | null;
  workers: string[];
}

interface ClaimedPage {
  status: number;
  worker: string | null;
  value?: number;
}

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

async function diagnostics(
  request: APIRequestContext,
  run: string
): Promise<Diagnostics> {
  const response = await request.get(
    `/distributed-live/diagnostics?run=${encodeURIComponent(run)}`,
    { headers: { "X-FluxFast": "1" } }
  );
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Diagnostics>;
}

async function claimCachedResource(page: Page, run: string): Promise<ClaimedPage> {
  for (let batch = 0; batch < 4; batch += 1) {
    const results = await page.evaluate(async ({ base, offset }) => {
      return Promise.all(Array.from({ length: 16 }, async (_, index) => {
        const response = await fetch(`${base}&attempt=${offset + index}`, {
          headers: {
            Accept: "application/vnd.fluxfast+json",
            "X-FluxFast": "1",
            "X-FluxFast-Protocol": "1",
          },
        });
        const payload = await response.json();
        return {
          status: response.status,
          worker: response.headers.get("x-fluxfast-test-worker"),
          value: payload.resources?.["distributed-counter"]?.value?.value,
          claimed: payload.page?.meta?.claimed === true,
        };
      }));
    }, {
      base: `${distributedUrl(run, "b")}&claim=1`,
      offset: batch * 16,
    });
    for (const result of results) expect(result.status).toBe(200);
    const claimed = results.find(result => result.claimed);
    if (claimed) return claimed;
  }
  throw new Error("Browser B could not claim a distinct FastAPI worker");
}

test("production runtime coordinates Redis state across three workers", async ({
  browser,
  request,
  baseURL,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const expectedOrigin = new URL(baseURL!).origin;
  const unexpectedOrigins = new Set<string>();
  const protocolOrigins = new Set<string>();
  const errors: string[] = [];
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  for (const page of [first, second]) {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", browserRequest => {
      const url = new URL(browserRequest.url());
      if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
        const requestOrigin = url.origin.replace(/^ws/, "http");
        if (requestOrigin !== expectedOrigin) unexpectedOrigins.add(requestOrigin);
      }
      if (browserRequest.headers()["x-fluxfast"] === "1") {
        protocolOrigins.add(url.origin);
      }
    });
  }

  try {
    await first.goto(distributedUrl(run, "a"));
    await waitForLive(first);
    await expect(first.getByTestId("distributed-counter-value")).toHaveText("0");

    const warm = await diagnostics(request, run);
    expect(warm.workers).toHaveLength(3);
    expect(new Set(warm.workers).size).toBe(3);
    expect(warm.records["loader:a"]).toHaveLength(1);
    expect(warm.records["loader:b"]).toEqual([]);
    const loaderWorker = warm.records["loader:a"][0]!;
    await expect(first.getByTestId("distributed-page-worker")).toHaveText(
      loaderWorker
    );

    await second.goto(distributedUrl(run, "b"));
    await waitForLive(second);
    await expect(second.getByTestId("distributed-counter-value")).toHaveText("0");

    const claimed = await claimCachedResource(second, run);
    expect(claimed.worker).toBeTruthy();
    expect(claimed.worker).not.toBe(loaderWorker);
    expect(claimed.value).toBe(0);

    const reused = await diagnostics(request, run);
    expect(reused.records["loader:b"]).toEqual([]);
    expect(reused.records["claim:b"]).toEqual([claimed.worker!]);

    await first.getByRole("button", {
      name: "Increment distributed counter",
    }).click();
    await Promise.all([
      expect(first.getByTestId("distributed-counter-value")).toHaveText("1"),
      expect(second.getByTestId("distributed-counter-value")).toHaveText("1"),
    ]);

    const final = await diagnostics(request, run);
    expect(final.state).toBe(1);
    for (const role of ["stream:a", "stream:b", "refresh:a", "refresh:b"]) {
      expect(final.records[role].length, role).toBeGreaterThanOrEqual(1);
    }
    expect(final.records.mutation).toHaveLength(1);
    const mutationWorker = final.records.mutation[0]!;
    expect(mutationWorker).not.toBe(loaderWorker);
    expect(mutationWorker).not.toBe(claimed.worker);
    const workers = new Set([loaderWorker, claimed.worker!, mutationWorker]);
    expect(workers.size).toBe(3);
    expect([...workers].sort()).toEqual(final.workers);
    for (const worker of workers) {
      expect(worker).toMatch(/^production:\d+$/);
    }
    expect([...protocolOrigins]).toEqual([expectedOrigin]);
    expect([...unexpectedOrigins]).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(
      `/distributed-live/diagnostics?run=${encodeURIComponent(run)}`,
      { headers: { "X-FluxFast": "1" } }
    );
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
