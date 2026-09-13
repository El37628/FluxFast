import { afterEach, describe, expect, it, vi } from "vitest";
import { FluxRouter } from "../src/router";
import { ResourceStore } from "../src/store";
import { LiveManager } from "../src/live/manager";
import type { LiveEvent } from "../src/live/protocol";
import type { LiveConnection } from "../src/live/transport";
import type { PageEnvelope } from "../src/protocol";
import type { FluxTransport, VisitTransportRequest } from "../src/transport";

function retained(owner: object, field: string): number {
  const value = (owner as Record<string, unknown>)[field];
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  throw new TypeError(`Expected a collection at ${field}`);
}

function envelope(url: string, key: string, value: number): PageEnvelope {
  return {
    protocol: "fluxfast/1",
    page: { component: "lifecycle/index", url },
    resourceKeys: [key],
    resources: { [key]: { version: `opaque-${value}`, value } },
  };
}

function transport(): FluxTransport {
  let sequence = 0;
  return {
    async visit(request) {
      const key = request.only?.[0] ?? `resource-${++sequence}`;
      return envelope(request.url, key, sequence);
    },
    async mutate() {
      return { protocol: "fluxfast/1", mutation: { invalidate: [`absent-${++sequence}`] } };
    },
  };
}

const routers: FluxRouter[] = [];
function router(customTransport = transport()): FluxRouter {
  const runtime = new FluxRouter({
    transport: customTransport, deferHistory: true, maxResources: 16, maxPages: 8,
  });
  routers.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of routers.splice(0)) runtime.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

class Stream implements LiveConnection {
  private readonly controller = new AbortController();
  private waiter?: (result: IteratorResult<LiveEvent>) => void;
  private readonly queue: LiveEvent[] = [];
  readonly signal = this.controller.signal;

  constructor(private readonly onClose: () => void) {}

  emit(event: LiveEvent): void {
    if (this.signal.aborted) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: event });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    this.queue.length = 0;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
    this.onClose();
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveEvent> {
    return { next: () => {
      const event = this.queue.shift();
      if (event) return Promise.resolve({ done: false, value: event });
      if (this.signal.aborted) return Promise.resolve({ done: true, value: undefined });
      return new Promise(resolve => { this.waiter = resolve; });
    } };
  }
}

describe("v1 retained client lifecycle stress", () => {
  it("bounds unique navigation, prefetch, deferred, and mutation epoch identities", async () => {
    const runtime = router();
    for (let cycle = 0; cycle < 400; cycle += 1) {
      await runtime.visit(`/navigation/${cycle}`, { usePrefetch: false, preserveState: true });
      await runtime.prefetch(`/prefetch/${cycle}`);
      await runtime.loadResources([`deferred-${cycle}`], { reason: "deferred" });
      await runtime.mutate("/mutation");
      expect(retained(runtime.resourceStore, "records")).toBeLessThanOrEqual(16);
      expect(retained(runtime.resourceStore, "stateSnapshots")).toBeLessThanOrEqual(16);
      expect(retained(runtime.pageCache, "entries")).toBeLessThanOrEqual(8);
      expect(retained(runtime.prefetchManager, "cache")).toBeLessThanOrEqual(32);
      expect(retained(runtime.prefetchManager, "inFlight")).toBe(0);
      expect(retained(runtime.prefetchManager, "controllers")).toBe(0);
      expect((runtime as unknown as { activeController: unknown }).activeController).toBeNull();
    }
    expect(retained(runtime, "resourceEpochs")).toBeLessThanOrEqual(1_024);
    runtime.destroy();
    expect(retained(runtime, "resourceEpochs")).toBe(0);
  });

  it("settles controller ownership and pending manifests across 200 actual deferred navigations", async () => {
    const runtime = router({
      ...transport(),
      async visit(request) {
        const key = request.only?.[0] ?? `deferred-${request.url.slice(1)}`;
        const result = envelope(request.url, key, 1);
        return request.only ? result : { ...result, resources: {}, deferred: [key] };
      },
    });
    for (let cycle = 0; cycle < 200; cycle += 1) {
      await runtime.visit(`/batch-${cycle}`, { usePrefetch: false });
      await flush();
      expect(runtime.resourceStore.getStateSnapshot(`deferred-batch-${cycle}`)).toMatchObject({
        data: 1, status: "ready", error: null, stale: false,
      });
      expect(retained(runtime, "activeDeferredEpochs")).toBe(0);
      expect(retained(runtime, "activeDeferredKeys")).toBe(0);
      expect((runtime as unknown as { activeDeferredController: unknown }).activeDeferredController).toBeNull();
      expect(runtime.pageCache.getValid(`/batch-${cycle}`, runtime.resourceStore)?.pendingDeferred).toEqual([]);
      expect(retained(runtime.resourceStore, "records")).toBeLessThanOrEqual(16);
      expect(retained(runtime.resourceStore, "stateSnapshots")).toBeLessThanOrEqual(16);
    }
  });

  it.each(["pending", "loading", "error"] as const)("bounds state-only %s identities with ready values in the same LRU", status => {
    const store = new ResourceStore({ maxResources: 16 });
    store.set({ key: "old-value", version: "old", value: 0 });
    for (let cycle = 0; cycle < 200; cycle += 1) {
      const key = `state-${cycle}`;
      if (status === "pending") store.markPending([key]);
      if (status === "loading") store.markLoading([key]);
      if (status === "error") store.setResourceError(key, { type: "ResourceError", message: "controlled" });
    }
    expect(retained(store, "stateSnapshots")).toBe(16);
    expect(retained(store, "lruOrder")).toBe(16);
    expect(store.getStateSnapshot("state-0").status).toBe("missing");
    expect(store.getStateSnapshot("state-199").status).toBe(status);
    expect(store.getSnapshot("old-value")).toBeUndefined();
    store.clear();
    expect(retained(store, "records")).toBe(0);
    expect(retained(store, "stateSnapshots")).toBe(0);
    expect(retained(store, "lruOrder")).toBe(0);
  });

  it("keeps recently read error metadata and notifies eviction without retaining unsubscribed listeners", () => {
    const store = new ResourceStore({ maxResources: 2 });
    const evicted = vi.fn();
    const unsubscribe = store.subscribe("old", evicted);
    store.setResourceError("old", { type: "ResourceError", message: "old" });
    store.markPending(["recent"]);
    const recent = store.getStateSnapshot("recent");
    store.markLoading(["new"]);
    expect(store.getStateSnapshot("old").status).toBe("missing");
    expect(store.getStateSnapshot("recent")).toBe(recent);
    expect(evicted).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribe();
    expect(retained(store, "subscribers")).toBe(0);
  });

  it("rejects old resource loads even after their epoch identity is evicted", async () => {
    let settle!: (value: PageEnvelope) => void;
    let invalidateShared = true;
    const ordinary = transport();
    const runtime = router({
      ...ordinary,
      visit(request) {
        if (request.only?.includes("shared")) return new Promise(resolve => { settle = resolve; });
        return ordinary.visit(request);
      },
      mutate(request) {
        if (!invalidateShared) return ordinary.mutate(request);
        invalidateShared = false;
        return Promise.resolve({ protocol: "fluxfast/1", mutation: { invalidate: ["shared"] } });
      },
    });
    const old = runtime.loadResources(["shared"], { reason: "refresh" });
    for (let cycle = 0; cycle < 1_100; cycle += 1) await runtime.mutate("/mutation");
    settle(envelope("/", "shared", -1));
    await old;
    expect(runtime.resourceStore.getSnapshot("shared")).toBeUndefined();
    expect(retained(runtime, "resourceEpochs")).toBeLessThanOrEqual(1_024);
  });

  it("never makes an old prefetch reusable after newer authority and cache eviction", async () => {
    let settle!: (value: PageEnvelope) => void;
    const ordinary = transport();
    const runtime = router({
      ...ordinary,
      visit(request) {
        if (request.url === "/obsolete") return new Promise(resolve => { settle = resolve; });
        return ordinary.visit(request);
      },
    });
    const old = runtime.prefetch("/obsolete");
    for (let cycle = 0; cycle < 1_100; cycle += 1) await runtime.mutate("/mutation");
    settle(envelope("/obsolete", "absent-1", -1));
    await old;
    expect(runtime.resourceStore.getSnapshot("absent-1")).toBeUndefined();
    expect(runtime.prefetchManager.getCached("/obsolete", {})).toBeUndefined();
    expect(runtime.pageCache.getValid("/obsolete", runtime.resourceStore)).toBeUndefined();
  });

  it.each(["clear", "destroy"] as const)("%s between prefetch transport completion and router settlement isolates the old session", async boundary => {
    let settle!: (value: PageEnvelope) => void;
    const response = new Promise<PageEnvelope>(resolve => { settle = resolve; });
    const runtime = router({ ...transport(), visit: () => response });
    const work = runtime.prefetch("/obsolete");
    const success = vi.fn();
    runtime.on("prefetch:success", success);
    // Manager cache acceptance runs first; the router's awaited settlement is
    // still queued when this boundary runs. Cancellation alone cannot guard it.
    void response.then(() => queueMicrotask(() => {
      runtime[boundary]();
      runtime.resourceStore.set({ key: "shared", version: "new", value: 1 });
      runtime.on("prefetch:success", success);
    }));
    settle(envelope("/obsolete", "shared", -1));
    await work;
    expect(runtime.resourceStore.getSnapshot("shared")).toBe(1);
    expect(runtime.pageCache.getValid("/obsolete", runtime.resourceStore)).toBeUndefined();
    expect(runtime.prefetchManager.getCached("/obsolete", {})).toBeUndefined();
    expect(success).not.toHaveBeenCalled();
  });

  it.each(["absent-1", "fresh"])("recovers missing navigation resource %s canonically after epoch eviction pressure", async key => {
    let settle!: (value: PageEnvelope) => void;
    const loads: VisitTransportRequest[] = [];
    const ordinary = transport();
    const runtime = router({
      ...ordinary,
      visit(request) {
        if (!request.only) return new Promise(resolve => { settle = resolve; });
        loads.push(request);
        return Promise.resolve(envelope(request.url, request.only[0], 1));
      },
    });
    const navigation = runtime.visit("/latest", { usePrefetch: false });
    await Promise.resolve();
    for (let cycle = 0; cycle < 1_100; cycle += 1) await runtime.mutate("/mutation");
    settle(envelope("/latest", key, -1));
    await navigation;
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(runtime.pageStore.getSnapshot().url).toBe("/latest");
    expect(runtime.resourceStore.getSnapshot(key)).toBe(1);
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ url: "/latest", only: [key] });
  });

  it("conservative eviction history cannot let speculation pin a navigation resource", async () => {
    let settle!: (value: PageEnvelope) => void;
    const ordinary = transport();
    let canonicalLoads = 0;
    const runtime = router({
      ...ordinary,
      visit(request) {
        if (request.url === "/latest" && !request.only) {
          return new Promise(resolve => { settle = resolve; });
        }
        if (request.only) { canonicalLoads += 1; return Promise.resolve(envelope(request.url, "shared", 3)); }
        return Promise.resolve(envelope(request.url, "shared", 2));
      },
    });
    const navigation = runtime.visit("/latest", { usePrefetch: false });
    await Promise.resolve();
    for (let cycle = 0; cycle < 1_100; cycle += 1) await runtime.mutate("/mutation");
    await runtime.prefetch("/speculative");
    settle(envelope("/latest", "shared", -1));
    await navigation;
    await flush();
    expect(runtime.pageStore.getSnapshot().url).toBe("/latest");
    expect(runtime.resourceStore.getSnapshot("shared")).toBe(3);
    expect(canonicalLoads).toBe(1);
  });

  it("rejecting a raced prefetch does not cancel another prefetch-backed navigation", async () => {
    const pending = new Map<string, (value: PageEnvelope) => void>();
    const ordinary = transport();
    const runtime = router({
      ...ordinary,
      visit(request) {
        return new Promise((resolve, reject) => {
          pending.set(request.url, resolve);
          request.signal?.addEventListener("abort", () => {
            const error = new Error("transport cancellation");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const raced = runtime.prefetch("/obsolete");
    const serving = runtime.prefetch("/latest");
    const navigation = runtime.visit("/latest");
    await Promise.resolve();
    await runtime.mutate("/mutation");
    pending.get("/obsolete")!(envelope("/obsolete", "absent-1", -1));
    await raced;
    pending.get("/latest")!(envelope("/latest", "fresh", 1));
    await Promise.all([serving, navigation]);
    expect(runtime.pageStore.getSnapshot().url).toBe("/latest");
    expect(runtime.resourceStore.getSnapshot("fresh")).toBe(1);
    expect(runtime.prefetchManager.getCached("/obsolete", {})).toBeUndefined();
  });

  it("scopes rejection to its manager and permits a fresh response reusing a frozen envelope", async () => {
    const frozen = Object.freeze(envelope("/shared", "absent-1", 1));
    let settle!: (value: PageEnvelope) => void;
    let first = true;
    const raced = router({
      ...transport(),
      visit: () => {
        if (!first) return Promise.resolve(frozen);
        first = false;
        return new Promise(resolve => { settle = resolve; });
      },
    });
    const independent = router({ ...transport(), visit: () => Promise.resolve(frozen) });
    const work = raced.prefetch("/shared");
    await raced.mutate("/mutation");
    settle(frozen);
    await work;
    expect(raced.prefetchManager.getCached("/shared", {})).toBeUndefined();
    await independent.prefetch("/shared");
    expect(independent.prefetchManager.getCached("/shared", independent.resourceStore.exportKnownVersions())).toBe(frozen);
    await raced.prefetch("/shared");
    expect(raced.prefetchManager.getCached("/shared", raced.resourceStore.exportKnownVersions())).toBe(frozen);
  });

  it("canonically reloads a known-version omission if its value was evicted during navigation", async () => {
    let settle!: (value: PageEnvelope) => void;
    const loads: string[] = [];
    const runtime = router({
      ...transport(),
      visit(request) {
        if (!request.only) {
          expect(request.knownVersions.shared).toBe("old");
          return new Promise(resolve => { settle = resolve; });
        }
        loads.push(request.only[0]);
        return Promise.resolve(envelope(request.url, request.only[0], 1));
      },
    });
    runtime.resourceStore.set({ key: "shared", version: "old", value: 0 });
    const navigation = runtime.visit("/latest", { usePrefetch: false });
    await Promise.resolve();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await runtime.loadResources([`fresh-${cycle}`], { reason: "refresh" });
    }
    expect(runtime.resourceStore.getSnapshot("shared")).toBeUndefined();
    settle({ ...envelope("/latest", "shared", 0), resources: {} });
    await navigation;
    await flush();
    expect(runtime.resourceStore.getSnapshot("shared")).toBe(1);
    expect(loads.filter(key => key === "shared")).toHaveLength(1);
    expect(runtime.pageStore.getSnapshot().url).toBe("/latest");
  });

  it.each(["clear", "destroy"] as const)("a reentrant %s during visit success cannot start obsolete deferred work", async boundary => {
    let loads = 0;
    const runtime = router({
      ...transport(),
      async visit(request) {
        loads += 1;
        return {
          ...envelope(request.url, "deferred", 0), resources: {}, deferred: ["deferred"],
        };
      },
    });
    runtime.on("visit:success", () => runtime[boundary]());
    await runtime.visit("/obsolete", { usePrefetch: false });
    await flush();
    expect(loads).toBe(1);
    expect(retained(runtime, "activeDeferredEpochs")).toBe(0);
    expect(retained(runtime, "resourceEpochs")).toBe(0);
  });

  it.each(["resources", "errors", "deferred", "page"] as const)("reentrant session boundaries during %s settlement stop the remaining envelope", async phase => {
    for (const boundary of ["clear", "destroy"] as const) {
      const result: PageEnvelope = {
        ...envelope("/obsolete", "first", -1), resourceKeys: ["first", "second"],
        resources: phase === "resources" || phase === "page" ? {
          ...envelope("/obsolete", "first", -1).resources,
          second: { version: "old", value: -1 },
        } : {},
        ...(phase === "errors" ? { resourceErrors: {
          first: { type: "ResourceError", message: "old" },
          second: { type: "ResourceError", message: "old" },
        } } : {}),
        ...(phase === "deferred" ? { deferred: ["first", "second"] } : {}),
      };
      const runtime = router({ ...transport(), visit: async () => result });
      let pendingBoundary = true;
      const close = () => {
        if (!pendingBoundary) return;
        pendingBoundary = false;
        runtime[boundary]();
        runtime.resourceStore.set({ key: "first", version: "new", value: 1 });
      };
      const unsubscribe = phase === "page"
        ? runtime.pageStore.subscribe(close)
        : runtime.resourceStore.subscribe("first", close);
      await runtime.visit("/obsolete", { usePrefetch: false });
      await flush();
      expect(runtime.resourceStore.getSnapshot("first")).toBe(1);
      if (phase !== "page") {
        expect(runtime.resourceStore.getStateSnapshot("second").status).toBe("missing");
      }
      if (boundary === "clear" || phase !== "page") {
        expect(runtime.pageStore.getSnapshot().url).toBe("");
      }
      expect(runtime.pageCache.getValid("/obsolete", runtime.resourceStore)).toBeUndefined();
      expect(runtime.liveManager.getManifest()).toBeUndefined();
      unsubscribe();
    }
  });

  it.each(["prefetch", "load", "load-start", "load-failure"] as const)("reentrant logout during %s cannot apply remaining batch keys or diagnostics", async phase => {
    const failure = new Error("controlled failure");
    let requests = 0;
    const runtime = router({
      ...transport(),
      async visit(request) {
        requests += 1;
        if (phase === "load-failure") throw failure;
        return { ...envelope(request.url, "first", -1), resources: {
          ...envelope(request.url, "first", -1).resources,
          second: { version: "old", value: -1 },
        } };
      },
    });
    let closed = false;
    const diagnostics = vi.fn();
    const unsubscribe = runtime.resourceStore.subscribe("first", () => {
      const state = runtime.resourceStore.getStateSnapshot("first");
      if (closed || (phase === "load-failure" && state.status !== "error") ||
          (phase === "load" && state.status !== "ready")) return;
      closed = true;
      runtime.clear();
      runtime.resourceStore.set({ key: "first", version: "new", value: 1 });
      runtime.on("prefetch:success", diagnostics);
      runtime.on("resource:load:success", diagnostics);
      runtime.on("resource:load:error", diagnostics);
    });
    if (phase === "prefetch") await runtime.prefetch("/obsolete");
    else {
      const work = runtime.loadResources(["first", "second"], { reason: "refresh" });
      if (phase === "load-failure") await expect(work).rejects.toBe(failure);
      else await work;
    }
    expect(runtime.resourceStore.getSnapshot("first")).toBe(1);
    expect(runtime.resourceStore.getStateSnapshot("second").status).toBe("missing");
    expect(diagnostics).not.toHaveBeenCalled();
    expect(requests).toBe(phase === "load-start" ? 0 : 1);
    unsubscribe();
  });

  it("a resource-start listener can clear the session before transport dispatch", async () => {
    let requests = 0;
    const ordinary = transport();
    const runtime = router({
      ...ordinary,
      visit(request) { requests += 1; return ordinary.visit(request); },
    });
    runtime.on("resource:load:start", () => {
      runtime.clear();
      runtime.resourceStore.set({ key: "first", version: "new", value: 1 });
    });
    await runtime.loadResources(["first", "second"], { reason: "refresh" });
    expect(requests).toBe(0);
    expect(runtime.resourceStore.getSnapshot("first")).toBe(1);
    expect(runtime.resourceStore.getStateSnapshot("second").status).toBe("missing");
  });

  it("releases history and resource/event subscriptions through 200 start/stop cycles", async () => {
    const runtime = router();
    let callback: ((url: string) => void) | undefined;
    let activeHistory = 0;
    vi.spyOn(runtime.history, "onPopState").mockImplementation(listener => {
      callback = listener;
      activeHistory += 1;
      return () => { callback = undefined; activeHistory -= 1; };
    });
    await runtime.visit("/history", { usePrefetch: false });
    const hits = vi.fn();
    for (let cycle = 0; cycle < 200; cycle += 1) {
      const stopEvent = runtime.on("cache:hit", hits);
      const stopKey = runtime.resourceStore.subscribe("observed", () => undefined);
      const stopAll = runtime.resourceStore.subscribeAll(() => undefined);
      const stopPage = runtime.pageStore.subscribe(() => undefined);
      runtime.startHistory();
      runtime.startHistory();
      expect(activeHistory).toBe(1);
      callback!("/history");
      runtime.stopHistory();
      runtime.stopHistory();
      stopEvent(); stopKey(); stopAll(); stopPage();
      expect(activeHistory).toBe(0);
      expect(retained(runtime.events, "listeners")).toBe(0);
      expect(retained(runtime.resourceStore, "subscribers")).toBe(0);
      expect(retained(runtime.resourceStore, "globalSubscribers")).toBe(0);
      expect(retained(runtime.pageStore, "subscribers")).toBe(0);
    }
    expect(hits).toHaveBeenCalledTimes(200);
  });

  it("keeps one stream/network subscription and releases timers through 200 reconnect cycles", async () => {
    vi.useFakeTimers();
    let activeStreams = 0;
    let maximumStreams = 0;
    let networkSubscriptions = 0;
    let latest!: Stream;
    const manager = new LiveManager({
      clientId: "lifecycle-stress-client",
      network: {
        isOnline: () => true,
        subscribe: () => {
          networkSubscriptions += 1;
          return () => { networkSubscriptions -= 1; };
        },
      },
      transport: { connect: () => {
        activeStreams += 1;
        maximumStreams = Math.max(maximumStreams, activeStreams);
        latest = new Stream(() => { activeStreams -= 1; });
        return latest;
      } },
    });
    const runtime = new FluxRouter({
      transport: transport(), liveManager: manager, deferHistory: true,
      liveBatchDelayMs: 5,
      initialEnvelope: { ...envelope("/live", "shared", 0), live: ["shared"] },
    });
    routers.push(runtime);
    for (let cycle = 0; cycle < 200; cycle += 1) {
      runtime.startLive();
      latest.emit({ protocol: "fluxfast/1", type: "ready", keys: ["shared"] });
      latest.emit({ protocol: "fluxfast/1", type: "invalidate", keys: ["shared"] });
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      runtime.stopLive();
      expect(vi.getTimerCount()).toBe(0);
      expect(activeStreams).toBe(0);
      expect(networkSubscriptions).toBe(0);
      runtime.startLive();
      const obsolete = latest;
      manager.reconnect();
      expect(obsolete.signal.aborted).toBe(true);
      latest.emit({ protocol: "fluxfast/1", type: "ready", keys: ["shared"] });
      await flush();
      await vi.advanceTimersByTimeAsync(5);
      expect(activeStreams).toBe(1);
      expect(networkSubscriptions).toBe(1);
      expect(retained(runtime, "activeLiveLoadEpochs")).toBe(0);
      expect(retained(runtime, "pendingLiveRefreshKeys")).toBe(0);
      runtime.stopLive();
      expect(vi.getTimerCount()).toBe(0);
    }
    runtime.destroy();
    expect(maximumStreams).toBe(1);
    expect(activeStreams).toBe(0);
    expect(networkSubscriptions).toBe(0);
    expect(retained(manager, "eventSubscribers")).toBe(0);
    expect(retained(manager, "diagnosticSubscribers")).toBe(0);
    expect(retained(manager, "subscribers")).toBe(0);
  });

  it("releases controller, epoch, prefetch, stream and listener ownership across 200 routers", async () => {
    for (let cycle = 0; cycle < 200; cycle += 1) {
      const runtime = router();
      await runtime.visit(`/owned/${cycle}`, { usePrefetch: false });
      await runtime.prefetch(`/owned-prefetch/${cycle}`);
      await runtime.loadResources(["deferred"], { reason: "deferred" });
      const unsubscribe = runtime.on("resource:update", () => undefined);
      unsubscribe();
      runtime.destroy();
      runtime.destroy();
      expect(retained(runtime, "resourceEpochs")).toBe(0);
      expect(retained(runtime, "activeDeferredEpochs")).toBe(0);
      expect(retained(runtime, "activeLiveLoadEpochs")).toBe(0);
      expect(retained(runtime.events, "listeners")).toBe(0);
      expect(retained(runtime.liveManager, "eventSubscribers")).toBe(0);
      expect(retained(runtime.liveManager, "diagnosticSubscribers")).toBe(0);
      expect(retained(runtime.prefetchManager, "cache")).toBe(0);
      expect(retained(runtime.prefetchManager, "controllers")).toBe(0);
      expect((runtime as unknown as { activeController: unknown }).activeController).toBeNull();
    }
  });
});
