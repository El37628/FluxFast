import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

interface Diagnostics {
  records: Record<string, string[]>;
  calls: Record<string, number>;
  state: number | null;
  workers: string[];
  scopedReady: boolean;
}

interface ClaimedPage {
  status: number;
  worker: string | null;
  value?: number;
  version?: string;
}

interface ScopedLiveEvent {
  type: string;
  keys?: string[];
  originClientId?: string;
}

declare global {
  interface Window {
    scopedGate?: { controller: AbortController; events: ScopedLiveEvent[] };
  }
}

async function startScopedStream(page: Page, url: string): Promise<ScopedLiveEvent> {
  return page.evaluate(async streamUrl => {
    const controller = new AbortController();
    const events: ScopedLiveEvent[] = [];
    window.scopedGate = { controller, events };
    const response = await fetch(streamUrl, {
      headers: {
        Accept: "text/event-stream", "X-FluxFast": "1", "X-FluxFast-Protocol": "1",
        "X-FluxFast-Live": "1", "X-FluxFast-Capabilities": "live-resources",
        "X-FluxFast-Live-Keys": "scoped-user,scoped-tenant,scoped-secret",
        "X-FluxFast-Scope": "tenant:tenant-a", "X-FluxFast-User": "alice",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Scoped live request failed: ${response.status}`);
    return new Promise<ScopedLiveEvent>((resolve, reject) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      void (async () => {
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, boundary).replace(/\r$/, "");
              buffer = buffer.slice(boundary + 1);
              if (!line.startsWith("data: ")) continue;
              const event = JSON.parse(line.slice(6)) as ScopedLiveEvent;
              events.push(event);
              if (event.type === "ready") resolve(event);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            events.push({ type: "stream-error" });
            reject(error);
          }
        }
      })();
    });
  }, url);
}

async function scopedOrigins(page: Page): Promise<string[]> {
  return page.evaluate(() => window.scopedGate!.events
    .filter(event => event.type !== "ready")
    .map(event => event.originClientId ?? event.type));
}

async function scopedMutation(page: Page, run: string, key: string, origin: string): Promise<void> {
  const status = await page.evaluate(async command => {
    const response = await fetch("/distributed-scoped/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-FluxFast": "1", "X-FluxFast-Client-ID": command.origin },
      body: JSON.stringify({ run: command.run, key: command.key, tenant: "tenant-a", scope: "tenant:tenant-a" }),
    });
    return response.status;
  }, { run, key, origin });
  expect(status).toBe(200);
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
          version: payload.resources?.["distributed-counter"]?.version,
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
    expect(claimed.version).toBeTruthy();

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
    // Concurrent cold refreshes may duplicate loader work. Once both browsers
    // converge, later sequential requests must reuse the exact fresh record.
    const freshRecords = await second.evaluate(async url => {
      const records = [];
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${url}&warm=${index}`, {
          headers: { "X-FluxFast": "1", "X-FluxFast-Only": "distributed-counter" },
        });
        if (!response.ok) throw new Error(`Warm refresh failed: ${response.status}`);
        records.push((await response.json()).resources["distributed-counter"]);
      }
      return records;
    }, distributedUrl(run, "b"));
    expect(freshRecords[0].value).toEqual({ value: 1 });
    expect(freshRecords[0].version).not.toBe(claimed.version);
    expect(freshRecords[1]).toEqual(freshRecords[0]);
    const later = await diagnostics(request, run);
    expect(later.calls["loader:a"]).toBe(final.calls["loader:a"]);
    expect(later.calls["loader:b"]).toBe(final.calls["loader:b"]);
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

test("production browser reconnect reloads canonical state after a missed signal", async ({
  page, request,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(distributedUrl(run, "a"));
    await waitForLive(page);
    await expect(page.getByTestId("distributed-counter-value")).toHaveText("0");
    const before = await diagnostics(request, run);
    const dropped = await request.post(
      `/distributed-live/disconnect?run=${encodeURIComponent(run)}`,
      { headers: { "X-FluxFast": "1" } }
    );
    expect(dropped.ok()).toBe(true);
    expect((await dropped.json()).disconnected).toBeGreaterThan(0);
    await expect(page.getByTestId("distributed-counter-value")).toHaveText("1", { timeout: 15_000 });
    await waitForLive(page);
    const recovered = await diagnostics(request, run);
    expect(recovered.calls["stream:a"]).toBeGreaterThan(before.calls["stream:a"]);
    expect(recovered.calls["refresh:a"]).toBeGreaterThan(before.calls["refresh:a"]);
    expect(recovered.calls["loader:a"]).toBeGreaterThan(before.calls["loader:a"]);
    expect(recovered.state).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/distributed-live/diagnostics?run=${encodeURIComponent(run)}`, {
      headers: { "X-FluxFast": "1" },
    });
  }
});

test("production cookies own user/tenant scopes and reject forged live resources", async ({
  browser, request, baseURL,
}, testInfo) => {
  const run = uniqueRun(testInfo);
  const contexts = await Promise.all(["alice", "bob", "carol"].map(async identity => {
    const context = await browser.newContext();
    await context.addCookies([{ name: "fixture-session", value: `session-${identity}`, url: baseURL!, httpOnly: true }]);
    return context;
  }));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [alice, bob, carol] = pages;
  const errors: string[] = [];
  const origins = new Set<string>();
  for (const page of pages) {
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", outgoing => origins.add(new URL(outgoing.url()).origin));
  }
  const url = `/distributed-scoped?run=${encodeURIComponent(run)}&user=alice&tenant=tenant-a&scope=tenant:tenant-a`;
  async function fetchScoped(page: Page) {
    return page.evaluate(async scopedUrl => {
      const response = await fetch(scopedUrl, { headers: { "X-FluxFast": "1", "X-FluxFast-Scope": "tenant:tenant-a" } });
      if (!response.ok) throw new Error(`Scoped resource request failed: ${response.status}`);
      return (await response.json()).resources;
    }, url);
  }
  try {
    for (const page of pages) {
      await page.goto(distributedUrl(run, "a"));
      await waitForLive(page);
    }
    const first = await fetchScoped(alice!);
    const peer = await fetchScoped(bob!);
    const other = await fetchScoped(carol!);
    expect(first["scoped-user"].value.owner).toBe("alice");
    expect(peer["scoped-user"].value.owner).toBe("bob");
    expect(peer["scoped-tenant"]).toEqual(first["scoped-tenant"]);
    expect(other["scoped-user"].value.owner).toBe("carol");
    expect(other["scoped-tenant"].value.owner).toBe("tenant-b");
    expect(other["scoped-secret"]).toBeUndefined();
    for (const page of pages) {
      const ready = await startScopedStream(page, url);
      expect(ready.keys).toEqual(page === carol ? ["scoped-tenant", "scoped-user"] : ["scoped-secret", "scoped-tenant", "scoped-user"]);
    }
    await expect.poll(async () => (await diagnostics(request, run)).scopedReady).toBe(true);
    for (const [page, key, origin] of [
      [alice!, "scoped-user", "scope_alice"], [bob!, "scoped-user", "scope_bob"],
      [carol!, "scoped-user", "scope_carol"], [carol!, "scoped-tenant", "tenant_carol"],
      [alice!, "scoped-tenant", "tenant_alice"], [alice!, "scoped-user", "scope_alice_again"],
      [bob!, "scoped-user", "scope_bob_again"], [carol!, "scoped-user", "scope_carol_again"],
    ] as const) await scopedMutation(page, run, key, origin);
    await expect.poll(() => scopedOrigins(alice!)).toEqual(["scope_alice", "tenant_alice", "scope_alice_again"]);
    await expect.poll(() => scopedOrigins(bob!)).toEqual(["scope_bob", "tenant_alice", "scope_bob_again"]);
    await expect.poll(() => scopedOrigins(carol!)).toEqual(["scope_carol", "tenant_carol", "scope_carol_again"]);
    const forgedStatus = await carol!.evaluate(async scopedUrl => {
      const response = await fetch(scopedUrl, {
        headers: { "X-FluxFast": "1", Accept: "text/event-stream", "X-FluxFast-Live": "1", "X-FluxFast-Capabilities": "live-resources", "X-FluxFast-Live-Keys": "scoped-secret", "X-FluxFast-Scope": "tenant:tenant-a" },
      });
      return response.status;
    }, url);
    expect(forgedStatus).toBe(409);
    const fresh = await fetchScoped(carol!);
    expect(fresh["scoped-tenant"].value).toEqual({ owner: "tenant-b", value: 1 });
    expect(fresh["scoped-user"].value).toEqual({ owner: "carol", value: 2 });
    expect((await fetchScoped(alice!))["scoped-tenant"].value).toEqual({ owner: "tenant-a", value: 1 });
    await contexts[2]!.clearCookies();
    const loggedOutStatus = await carol!.evaluate(async scopedUrl => (await fetch(scopedUrl, { headers: { "X-FluxFast": "1" } })).status, url);
    expect(loggedOutStatus).toBe(401);
    expect([...origins]).toEqual([new URL(baseURL!).origin]);
    expect(errors).toEqual([]);
  } finally {
    for (const page of pages) {
      if (!page.isClosed()) await page.evaluate(() => window.scopedGate?.controller.abort());
    }
    await Promise.all(contexts.map(context => context.close()));
    await request.delete(`/distributed-live/diagnostics?run=${encodeURIComponent(run)}`, { headers: { "X-FluxFast": "1" } });
  }
});
