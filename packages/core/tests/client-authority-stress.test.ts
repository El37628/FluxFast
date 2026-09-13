import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../src/live/protocol";
import type {
  LiveConnection, LiveConnectionOptions, LiveTransport,
} from "../src/live/transport";
import type { MutationEnvelope, PageEnvelope } from "../src/protocol";
import { FluxRouter } from "../src/router";
import type {
  FluxTransport, MutationTransportRequest, VisitTransportRequest,
} from "../src/transport";

// Deliberately ignore transport cancellation: generation checks must also
// reject work that completes after an abort or on a non-cancellable transport.
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ControlledTransport implements FluxTransport {
  readonly visits: Array<ReturnType<typeof pending<PageEnvelope>> & {
    request: VisitTransportRequest;
  }> = [];
  readonly mutations: Array<ReturnType<typeof pending<MutationEnvelope>> & {
    request: MutationTransportRequest;
  }> = [];

  visit(request: VisitTransportRequest): Promise<PageEnvelope> {
    const work = pending<PageEnvelope>();
    this.visits.push({ ...work, request });
    return work.promise;
  }

  mutate(request: MutationTransportRequest): Promise<MutationEnvelope> {
    const work = pending<MutationEnvelope>();
    this.mutations.push({ ...work, request });
    return work.promise;
  }
}

class ControlledConnection implements LiveConnection {
  private readonly controller = new AbortController();
  private readonly queue: LiveEvent[] = [];
  private waiter?: (event: IteratorResult<LiveEvent>) => void;
  readonly signal = this.controller.signal;

  emit(event: LiveEvent): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: event });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    this.controller.abort();
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.signal.aborted) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise(resolve => { this.waiter = resolve; });
      },
    };
  }
}

class ControlledLiveTransport implements LiveTransport {
  readonly connections: ControlledConnection[] = [];
  readonly requests: LiveConnectionOptions[] = [];

  connect(request: LiveConnectionOptions): LiveConnection {
    this.requests.push(request);
    const connection = new ControlledConnection();
    this.connections.push(connection);
    return connection;
  }
}

function page(url: string, value: number, key = "shared"): PageEnvelope {
  return {
    protocol: "fluxfast/1",
    page: { component: `${url.slice(1)}/index`, url },
    resourceKeys: [key],
    resources: { [key]: { version: `opaque-${value}`, value: { value } } },
  };
}

function patch(value: number): MutationEnvelope {
  return {
    protocol: "fluxfast/1",
    mutation: {
      patches: { shared: [{ op: "replace-resource", value: { value } }] },
    },
  };
}

function livePatch(value: number): LiveEvent {
  return {
    protocol: "fluxfast/1",
    type: "patch",
    patches: { shared: [{ op: "replace-resource", value: { value } }] },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const routers: FluxRouter[] = [];
afterEach(() => {
  for (const router of routers.splice(0)) router.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function runtime(initialEnvelope = page("/initial", 0)) {
  const transport = new ControlledTransport();
  const liveTransport = new ControlledLiveTransport();
  const hardNavigate = vi.fn();
  const router = new FluxRouter({
    transport, liveTransport, hardNavigate, initialEnvelope,
    liveBatchDelayMs: 5, deferHistory: true,
  });
  routers.push(router);
  return { router, transport, liveTransport, hardNavigate };
}

describe("v1 client authority stress", () => {
  it.each([false, true])("navigation + prefetch deduplicates (newer=%s)", async newer => {
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const { router, transport } = runtime();
      const prefetch = router.prefetch("/prefetched");
      const visit = router.visit("/prefetched");
      await flush();
      expect(transport.visits).toHaveLength(1);
      if (newer) {
        const latest = router.visit("/latest", { usePrefetch: false });
        await flush();
        transport.visits[1].resolve(page("/latest", cycle));
        await latest;
      }
      transport.visits[0].resolve(page("/prefetched", -cycle));
      await Promise.all([prefetch, visit]);
      expect(router.pageStore.getSnapshot().url).toBe(newer ? "/latest" : "/prefetched");
      expect(router.resourceStore.getSnapshot("shared")).toEqual({ value: newer ? cycle : -cycle });
      router.destroy();
    }
  });

  it.each(["visit", "mutation"] as const)("prefetch + newer %s cannot poison caches", async newer => {
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const { router, transport } = runtime();
      const prefetch = router.prefetch("/obsolete");
      if (newer === "visit") {
        const visit = router.visit("/latest", { usePrefetch: false });
        await flush();
        transport.visits[1].resolve(page("/latest", cycle));
        await visit;
      } else {
        const mutation = router.mutate("/change");
        transport.mutations[0].resolve(patch(cycle));
        await mutation;
      }
      transport.visits[0].resolve(page("/obsolete", -cycle));
      await prefetch;
      expect(router.resourceStore.getSnapshot("shared")).toEqual({ value: cycle });
      expect(router.prefetchManager.getCached("/obsolete", router.resourceStore.exportKnownVersions())).toBeUndefined();
      expect(router.pageCache.getValid("/obsolete", router.resourceStore)).toBeUndefined();
      router.destroy();
    }
  });

  it.each(["navigation", "mutation"] as const)("deferred + %s ignores late completion", async newer => {
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const initial = {
        ...page("/initial", 0), resources: {}, deferred: ["shared"],
      };
      const { router, transport } = runtime(initial);
      // A prior page's cached value remains visible during deferred loading.
      router.resourceStore.set({ key: "shared", version: "prior", value: { value: 0 } });
      const deferred = router.startInitialDeferred();
      if (newer === "navigation") {
        const visit = router.visit("/latest", { usePrefetch: false });
        await flush();
        transport.visits[1].resolve(page("/latest", cycle));
        await visit;
        expect(transport.visits[0].request.signal?.aborted).toBe(true);
      } else {
        const mutation = router.mutate("/change");
        transport.mutations[0].resolve(patch(cycle));
        await mutation;
      }
      transport.visits[0].resolve(page("/initial", -cycle));
      await deferred;
      expect(router.resourceStore.getSnapshot("shared")).toEqual({ value: cycle });
      expect(router.pageStore.getSnapshot().url).toBe(newer === "navigation" ? "/latest" : "/initial");
      router.destroy();
    }
  });

  it.each(["mutation", "resource-load"] as const)("pending navigation preserves a newer %s resource", async newer => {
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const { router, transport } = runtime();
      const visit = router.visit("/latest", { usePrefetch: false });
      await flush();
      if (newer === "mutation") {
        const mutation = router.mutate("/change");
        transport.mutations[0].resolve(patch(cycle));
        await mutation;
      } else {
        const load = router.loadResources(["shared"], { reason: "refresh" });
        transport.visits[1].resolve(page("/initial", cycle));
        await load;
      }
      transport.visits[0].resolve({
        ...page("/latest", -cycle),
        resourceKeys: ["shared", "fresh"],
        resources: {
          ...page("/latest", -cycle).resources,
          fresh: { version: `fresh-${cycle}`, value: cycle },
        },
      });
      await visit;
      expect(router.pageStore.getSnapshot().url).toBe("/latest");
      expect(router.resourceStore.getSnapshot("shared")).toEqual({ value: cycle });
      expect(router.resourceStore.getSnapshot("fresh")).toBe(cycle);
      router.destroy();
    }
  });

  it("old prefetch completion during navigation cannot suppress the navigation's canonical value", async () => {
    const { router, transport } = runtime();
    const prefetch = router.prefetch("/obsolete");
    const visit = router.visit("/latest", { usePrefetch: false });
    await flush();
    transport.visits[0].resolve(page("/obsolete", -1));
    await prefetch;
    transport.visits[1].resolve(page("/latest", 1));
    await visit;
    expect(router.resourceStore.getSnapshot("shared")).toEqual({ value: 1 });
    expect(router.pageStore.getSnapshot().url).toBe("/latest");
  });

  it.each(["omitted", "error", "deferred"] as const)("newer mutation survives an old navigation's %s resource metadata", async metadata => {
    const { router, transport } = runtime();
    const visit = router.visit("/latest", { usePrefetch: false });
    await flush();
    const mutation = router.mutate("/change");
    transport.mutations[0].resolve(patch(1));
    await mutation;
    const state = router.resourceStore.getStateSnapshot("shared");
    transport.visits[0].resolve({
      ...page("/latest", -1),
      resources: {},
      ...(metadata === "error" ? {
        resourceErrors: { shared: { type: "ResourceError", message: "obsolete" } },
      } : {}),
      ...(metadata === "deferred" ? { deferred: ["shared"] } : {}),
    });
    await visit;
    expect(router.resourceStore.getStateSnapshot("shared")).toBe(state);
    expect(transport.visits).toHaveLength(1);
    // A patched stale value must not make the new page cache appear valid.
    expect(router.pageCache.getValid("/latest", router.resourceStore)).toBeUndefined();
  });

  it("newer resource load still settles after an older navigation response", async () => {
    const { router, transport } = runtime();
    const visit = router.visit("/latest", { usePrefetch: false });
    await flush();
    const load = router.loadResources(["shared"], { reason: "refresh" });
    transport.visits[0].resolve(page("/latest", -1));
    await visit;
    expect(router.resourceStore.getStateSnapshot("shared").status).toBe("loading");
    transport.visits[1].resolve(page("/initial", 1));
    await load;
    expect(router.resourceStore.getStateSnapshot("shared")).toMatchObject({
      data: { value: 1 }, status: "ready", error: null, stale: false,
    });
    expect(router.pageStore.getSnapshot().url).toBe("/latest");
  });

  it.each(["mutation", "reconnect"] as const)("live + %s keeps the newer value", async newer => {
    vi.useFakeTimers();
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const { router, transport, liveTransport } = runtime({ ...page("/initial", 0), live: ["shared"] });
      router.startLive();
      liveTransport.connections[0].emit({ protocol: "fluxfast/1", type: "ready", keys: ["shared"] });
      await flush();
      liveTransport.connections[0].emit({ protocol: "fluxfast/1", type: "invalidate", keys: ["shared"] });
      await flush();
      await vi.advanceTimersByTimeAsync(5);
      expect(transport.visits).toHaveLength(1);
      if (newer === "mutation") {
        const mutation = router.mutate("/change");
        transport.mutations[0].resolve(patch(cycle));
        await mutation;
      } else {
        router.liveManager.reconnect();
        expect(liveTransport.connections[0].signal.aborted).toBe(true);
        liveTransport.connections[1].emit({ protocol: "fluxfast/1", type: "ready", keys: ["shared"] });
        liveTransport.connections[1].emit(livePatch(cycle));
        await flush();
      }
      transport.visits[0].resolve(page("/initial", -cycle));
      await flush();
      expect(router.resourceStore.getSnapshot("shared")).toEqual({ value: cycle });
      expect(router.resourceStore.isStale("shared")).toBe(true);
      router.destroy();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("history + live discards obsolete streams across repeated back/forward", async () => {
    vi.useFakeTimers();
    const { router, transport, liveTransport } = runtime({ ...page("/initial", 0), live: ["shared"] });
    let pop!: (url: string) => void;
    vi.spyOn(router.history, "onPopState").mockImplementation(callback => {
      pop = callback;
      return () => undefined;
    });
    router.startHistory();
    router.startLive();
    const visit = router.visit("/other", { usePrefetch: false });
    await flush();
    transport.visits[0].resolve({ ...page("/other", 1, "other"), live: ["other"] });
    await visit;
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const obsolete = liveTransport.connections.at(-1)!;
      pop("/initial");
      expect(obsolete.signal.aborted).toBe(true);
      obsolete.emit(livePatch(-cycle - 1));
      await flush();
      expect(router.resourceStore.getSnapshot("shared")).toEqual({ value: 0 });
      expect(router.liveManager.getManifest()).toEqual({ url: "/initial", keys: ["shared"] });
      pop("/other");
      expect(router.liveManager.getManifest()).toEqual({ url: "/other", keys: ["other"] });
    }
    expect(transport.visits).toHaveLength(1);
    router.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["clear", "destroy"] as const)("%s + every pending work type cannot restore state", async boundary => {
    vi.useFakeTimers();
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const { router, transport, liveTransport, hardNavigate } = runtime({
        ...page("/initial", 0), deferred: ["deferred"], live: ["shared"],
      });
      router.startLive();
      const oldConnection = liveTransport.connections[0];
      const deferred = router.startInitialDeferred();
      const prefetch = router.prefetch("/obsolete").catch(error => error);
      const visit = router.visit("/obsolete", { usePrefetch: false });
      await flush();
      const resource = router.loadResources(["shared"], { reason: "retry" });
      const mutation = router.mutate("/old-session");
      oldConnection.emit(livePatch(-cycle));
      await flush();
      router[boundary]();
      router.resourceStore.set({ key: "shared", version: `new-session-${cycle}`, value: { value: cycle } });
      const settled = vi.fn();
      const errors = vi.fn();
      router.on("resource:load:success", settled);
      router.on("resource:load:error", errors);
      for (const work of transport.visits) {
        work.resolve(page(work.request.url, -cycle));
      }
      transport.mutations[0].resolve({ ...patch(-cycle), mutation: {
        ...patch(-cycle).mutation, externalRedirect: "https://example.com/obsolete",
      } });
      await Promise.all([deferred, prefetch, visit, resource, mutation]);
      oldConnection.emit(livePatch(-cycle * 2));
      await flush();
      expect(router.resourceStore.getRecord("shared")).toMatchObject({ version: `new-session-${cycle}`, value: { value: cycle } });
      expect(router.pageStore.getSnapshot().url).toBe(boundary === "clear" ? "" : "/initial");
      expect(hardNavigate).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(oldConnection.signal.aborted).toBe(true);
      expect(transport.visits.filter(work => work.request.signal).every(work => work.request.signal!.aborted)).toBe(true);
      expect(router.prefetchManager.getCached("/obsolete", {})).toBeUndefined();
      expect(router.pageCache.getValid("/obsolete", router.resourceStore)).toBeUndefined();
      router.destroy();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it.each(["clear", "destroy"] as const)("%s isolates late resource failures but preserves caller errors", async boundary => {
    const { router, transport } = runtime();
    const load = router.loadResources(["shared"], { reason: "retry" });
    const failure = new Error("old-session diagnostic");
    const result = load.catch(error => error);
    router[boundary]();
    router.resourceStore.set({ key: "shared", version: "new", value: { value: 1 } });
    const errors = vi.fn();
    router.on("resource:load:error", errors);
    transport.visits[0].reject(failure);
    expect(await result).toBe(failure);
    expect(router.resourceStore.getStateSnapshot("shared")).toMatchObject({ data: { value: 1 }, status: "ready", error: null });
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(["internal", "external"] as const)("cached history supersedes old %s mutation redirects", async redirect => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const { router, transport, hardNavigate } = runtime();
      let pop!: (url: string) => void;
      vi.spyOn(router.history, "onPopState").mockImplementation(callback => {
        pop = callback;
        return () => undefined;
      });
      router.startHistory();
      const visit = router.visit("/other", { usePrefetch: false });
      await flush();
      transport.visits[0].resolve(page("/other", 1, "other"));
      await visit;
      const mutation = router.mutate("/old-redirect");
      pop("/initial");
      expect(router.pageStore.getSnapshot().url).toBe("/initial");
      transport.mutations[0].resolve({ protocol: "fluxfast/1", mutation: redirect === "internal"
        ? { redirect: "/obsolete" }
        : { externalRedirect: "https://example.com/obsolete" } });
      await flush();
      // Settle an unexpected navigation too, so regression failures cannot hang.
      if (transport.visits[1]) transport.visits[1].resolve(page("/obsolete", -1));
      await mutation;
      expect(transport.visits).toHaveLength(1);
      expect(hardNavigate).not.toHaveBeenCalled();
      expect(router.pageStore.getSnapshot().url).toBe("/initial");
      router.destroy();
    }
  });
});
