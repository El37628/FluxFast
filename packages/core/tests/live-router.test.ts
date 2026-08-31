import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryManager } from "../src/history";
import { LiveManager } from "../src/live/manager";
import type { LiveEvent } from "../src/live/protocol";
import type {
  LiveConnection,
  LiveConnectionOptions,
  LiveTransport,
} from "../src/live/transport";
import type { MutationEnvelope, PageEnvelope } from "../src/protocol";
import { FluxRouter } from "../src/router";
import type {
  FluxTransport,
  MutationTransportRequest,
  VisitTransportRequest,
} from "../src/transport";

afterEach(() => vi.useRealTimers());

class ControlledConnection implements LiveConnection {
  private readonly controller = new AbortController();
  private readonly events: LiveEvent[] = [];
  private waiter?: (result: IteratorResult<LiveEvent>) => void;
  public closeCount = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  emit(event: LiveEvent): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: event });
    } else {
      this.events.push(event);
    }
  }

  close(reason?: unknown): void {
    this.closeCount += 1;
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveEvent> {
    return {
      next: () => {
        const event = this.events.shift();
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
  public readonly requests: LiveConnectionOptions[] = [];
  public readonly connections: ControlledConnection[] = [];

  connect(options: LiveConnectionOptions): LiveConnection {
    this.requests.push(options);
    const connection = new ControlledConnection();
    this.connections.push(connection);
    return connection;
  }
}

class MockTransport implements FluxTransport {
  public readonly visitMock = vi.fn<
    (request: VisitTransportRequest) => Promise<PageEnvelope>
  >();
  public readonly mutateMock = vi.fn<
    (request: MutationTransportRequest) => Promise<MutationEnvelope>
  >();

  visit(request: VisitTransportRequest): Promise<PageEnvelope> {
    return this.visitMock(request);
  }

  mutate(request: MutationTransportRequest): Promise<MutationEnvelope> {
    return this.mutateMock(request);
  }
}

const ready = (keys: string[]): LiveEvent => ({
  protocol: "fluxfast/1",
  type: "ready",
  keys,
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("FluxRouter live invalidation synchronization", () => {
  it("emits count-only live runtime diagnostics", async () => {
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 10_000,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard?tenant=secret" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });
    const observed: Array<[string, unknown]> = [];
    const eventNames = [
      "live:connect:start",
      "live:connect:open",
      "live:connect:close",
      "live:reconnect",
      "live:event",
      "live:invalidate",
      "live:patch",
      "live:resync",
    ] as const;
    for (const name of eventNames) {
      router.on(name, payload => observed.push([name, payload]));
    }

    router.startLive();
    liveTransport.connections[0].emit(ready(["summary"]));
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary"],
    });
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        summary: [{ op: "replace-resource", value: { count: 2 } }],
      },
    });
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "resync",
      keys: ["summary"],
      reason: "server",
    });
    await flushMicrotasks();
    router.liveManager.reconnect();
    liveTransport.connections[1].emit(ready(["summary"]));
    await flushMicrotasks();
    router.stopLive();

    expect(observed).toEqual(expect.arrayContaining([
      ["live:connect:start", { keyCount: 1, reconnectAttempt: 0 }],
      ["live:connect:open", { keyCount: 1, reconnectAttempt: 0 }],
      ["live:reconnect", { keyCount: 1, reconnectAttempt: 1 }],
      ["live:event", { eventType: "ready", keyCount: 1 }],
      ["live:event", { eventType: "invalidate", keyCount: 1 }],
      ["live:invalidate", { keyCount: 1 }],
      ["live:event", { eventType: "patch", keyCount: 1 }],
      ["live:patch", { resourceCount: 1 }],
      ["live:event", { eventType: "resync", keyCount: 1 }],
      ["live:resync", { keyCount: 1, reason: "server" }],
      ["live:connect:close", {
        keyCount: 1,
        reconnectAttempt: 0,
        reason: "lifecycle",
        willReconnect: false,
      }],
    ]));
    expect(JSON.stringify(observed)).not.toContain("secret");
    expect(JSON.stringify(observed)).not.toContain("summary");
    router.destroy();
  });

  it("emits a fixed live transport error category without leaking details", () => {
    const router = new FluxRouter({
      liveTransport: {
        connect: () => {
          throw new Error("tenant secret and authorization token");
        },
      },
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard?tenant=secret" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });
    const errors: unknown[] = [];
    router.on("live:connect:error", payload => errors.push(payload));

    router.startLive();

    expect(errors).toEqual([{
      keyCount: 1,
      reconnectAttempt: 0,
      errorType: "transport",
    }]);
    expect(JSON.stringify(errors)).not.toContain("secret");
    expect(JSON.stringify(errors)).not.toContain("token");
    router.destroy();
  });

  it("shares one client identity and suppresses only its own live events", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    const liveManager = new LiveManager({
      transport: liveTransport,
      clientId: "ff_current_tab",
    });
    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: {},
    });
    const router = new FluxRouter({
      transport,
      liveManager,
      liveBatchDelayMs: 15,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });

    router.startLive();
    await router.mutate("/summary/increment");
    expect(router.clientId).toBe("ff_current_tab");
    expect(liveTransport.requests[0].clientId).toBe(router.clientId);
    expect(transport.mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: router.clientId })
    );

    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary"],
      originClientId: router.clientId,
    });
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        summary: [{ op: "replace-resource", value: { count: 2 } }],
      },
      originClientId: router.clientId,
    });
    await flushMicrotasks();
    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      data: { count: 1 },
      stale: false,
    });
    expect(transport.visitMock).not.toHaveBeenCalled();

    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        summary: [{ op: "replace-resource", value: { count: 3 } }],
      },
      originClientId: "ff_other_tab",
    });
    await flushMicrotasks();
    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      data: { count: 3 },
      stale: true,
    });
    router.destroy();
  });

  it("stays disconnected during SSR, then batches active invalidations", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    const liveManager = new LiveManager({ transport: liveTransport });
    const router = new FluxRouter({
      transport,
      liveManager,
      liveBatchDelayMs: 15,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["summary", "rooms"],
        resources: {
          summary: { version: "s1", value: { count: 1 } },
          rooms: { version: "r1", value: [{ id: 1 }] },
        },
        live: ["summary", "rooms"],
      },
    });
    const loadResources = vi.spyOn(router, "loadResources").mockResolvedValue();

    expect(liveTransport.connections).toHaveLength(0);
    router.startLive();
    router.startLive();
    expect(liveTransport.connections).toHaveLength(1);
    liveTransport.connections[0].emit(ready(["rooms", "summary"]));
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary", "unknown"],
    });
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary", "rooms"],
    });
    await flushMicrotasks();

    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 1 });
    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      stale: true,
      status: "ready",
    });
    expect(router.resourceStore.isStale("rooms")).toBe(true);
    expect(router.resourceStore.getStateSnapshot("unknown").status).toBe("missing");
    expect(loadResources).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15);

    expect(loadResources).toHaveBeenCalledOnce();
    expect(loadResources).toHaveBeenCalledWith(
      ["rooms", "summary"],
      { url: "/dashboard", reason: "live" }
    );
  });

  it("keeps initial deferred work through a Strict Mode live restart", async () => {
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveDeferred!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveDeferred = resolve; })
    );
    const router = new FluxRouter({
      transport,
      liveTransport,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["activity"],
        resources: {},
        deferred: ["activity"],
        live: ["activity"],
      },
    });

    const deferred = router.startInitialDeferred();
    router.startLive();
    router.stopLive();
    router.startLive();
    resolveDeferred({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { activity: { version: "a1", value: ["ready"] } },
    });
    await deferred;

    expect(router.resourceStore.getStateSnapshot("activity")).toMatchObject({
      data: ["ready"],
      status: "ready",
      stale: false,
    });
    expect(liveTransport.connections).toHaveLength(2);
    router.destroy();
  });

  it("supersedes only an active live refresh when live synchronization stops", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveLiveRefresh!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveLiveRefresh = resolve; })
    );
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 5,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });

    router.startLive();
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary"],
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5);
    router.stopLive();
    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      data: { count: 1 },
      status: "ready",
      stale: true,
    });

    resolveLiveRefresh({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { summary: { version: "late", value: { count: 99 } } },
    });
    await flushMicrotasks();
    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 1 });
    router.destroy();
  });

  it("canonically reloads all active keys after reconnect readiness", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: {
        activity: { version: "a2", value: ["new"] },
        summary: { version: "s2", value: { count: 2 } },
      },
    });
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 5,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: {
          activity: { version: "a1", value: ["old"] },
          summary: { version: "s1", value: { count: 1 } },
        },
        live: ["summary", "activity"],
      },
    });
    const resourceStarts = vi.fn();
    router.on("resource:load:start", resourceStarts);
    router.startLive();
    liveTransport.connections[0].emit(ready(["activity", "summary"]));
    await flushMicrotasks();

    router.liveManager.reconnect();
    liveTransport.connections[1].emit(ready(["activity", "summary"]));
    await flushMicrotasks();
    expect(router.resourceStore.isStale("activity")).toBe(true);
    expect(router.resourceStore.isStale("summary")).toBe(true);

    await vi.advanceTimersByTimeAsync(5);
    await flushMicrotasks();
    expect(transport.visitMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "/dashboard",
      only: ["activity", "summary"],
    }));
    expect(transport.visitMock.mock.calls[0][0]).toMatchObject({
      knownVersions: {},
    });
    expect(resourceStarts).toHaveBeenCalledWith({
      url: "/dashboard",
      keys: ["activity", "summary"],
      reason: "live-reconnect",
    });
    expect(router.resourceStore.getSnapshot("activity")).toEqual(["new"]);
    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 2 });
    router.destroy();
  });

  it("aborts the old stream during navigation and starts the new manifest", async () => {
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveVisit!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveVisit = resolve; })
    );
    const router = new FluxRouter({
      transport,
      liveTransport,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: {},
        live: ["summary"],
      },
    });
    router.startLive();

    const visiting = router.visit("/reports");
    await flushMicrotasks();
    expect(liveTransport.connections[0].closeCount).toBe(1);
    expect(liveTransport.connections).toHaveLength(1);

    resolveVisit({
      protocol: "fluxfast/1",
      page: { component: "reports/index", url: "/reports" },
      resources: {},
      live: ["activity"],
    });
    await visiting;

    expect(liveTransport.connections).toHaveLength(2);
    expect(liveTransport.requests[1]).toMatchObject({
      url: "/reports",
      keys: ["activity"],
    });
  });

  it("restores the cached live manifest across back and forward history", async () => {
    const history = new HistoryManager();
    let popState!: (url: string) => void;
    vi.spyOn(history, "onPopState").mockImplementation(callback => {
      popState = callback;
      return () => undefined;
    });
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    transport.visitMock
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["summary"],
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      })
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resourceKeys: ["rooms"],
        resources: { rooms: { version: "r1", value: [{ id: 1 }] } },
        live: ["rooms"],
      });
    const router = new FluxRouter({
      transport,
      history,
      liveTransport,
      deferHistory: true,
    });
    router.startHistory();
    router.startLive();

    await router.visit("/dashboard");
    await router.visit("/rooms");
    expect(liveTransport.connections[0].closeCount).toBe(1);
    expect(liveTransport.requests.map(request => request.keys)).toEqual([
      ["summary"],
      ["rooms"],
    ]);

    popState("/dashboard");
    expect(liveTransport.connections[1].closeCount).toBe(1);
    expect(liveTransport.requests[2]).toMatchObject({
      url: "/dashboard",
      keys: ["summary"],
    });
    expect(router.pageStore.getSnapshot().component).toBe("dashboard/index");

    liveTransport.connections[1].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        rooms: [{ op: "replace-resource", value: [{ id: 99 }] }],
      },
    });
    await flushMicrotasks();
    expect(router.resourceStore.getSnapshot("rooms")).toEqual([{ id: 1 }]);

    popState("/rooms");
    expect(liveTransport.connections[2].closeCount).toBe(1);
    expect(liveTransport.requests[3]).toMatchObject({
      url: "/rooms",
      keys: ["rooms"],
    });
    expect(router.pageStore.getSnapshot().component).toBe("rooms/index");
    expect(transport.visitMock).toHaveBeenCalledTimes(2);
    router.destroy();
  });

  it("stores prefetched live keys without opening a stream until navigation", async () => {
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resourceKeys: ["summary"],
      resources: { summary: { version: "s1", value: { count: 1 } } },
      live: ["summary"],
    });
    const router = new FluxRouter({
      transport,
      liveTransport,
      deferHistory: true,
    });
    router.startLive();

    await router.prefetch("/dashboard");
    expect(liveTransport.connections).toHaveLength(0);
    expect(router.pageCache.getValid("/dashboard", router.resourceStore))
      .toMatchObject({ liveKeys: ["summary"] });

    await router.visit("/dashboard");
    expect(transport.visitMock).toHaveBeenCalledTimes(1);
    expect(liveTransport.requests).toEqual([
      expect.objectContaining({
        url: "/dashboard",
        keys: ["summary"],
      }),
    ]);
    router.destroy();
  });

  it("does not connect old envelopes and clears live state on logout", () => {
    const liveTransport = new ControlledLiveTransport();
    const router = new FluxRouter({
      liveTransport,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "legacy/index", url: "/legacy" },
        resources: {},
      },
    });

    router.startLive();
    expect(liveTransport.connections).toHaveLength(0);

    router.liveManager.updateManifest("/dashboard", ["summary"]);
    router.startLive();
    expect(liveTransport.connections).toHaveLength(1);
    router.clear();

    expect(liveTransport.connections[0].closeCount).toBe(1);
    expect(router.liveManager.getManifest()).toBeUndefined();
    expect(router.liveManager.getSnapshot().status).toBe("idle");
  });

  it("rejects invalid batch timing", () => {
    expect(() => new FluxRouter({ liveBatchDelayMs: -1, deferHistory: true }))
      .toThrowError(/liveBatchDelayMs/);
  });

  it("applies active patches immediately and schedules canonical refresh", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 15,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resourceKeys: ["rooms", "summary"],
        resources: {
          rooms: { version: "r1", value: [{ id: 1, open: true }] },
        },
        live: ["rooms", "summary"],
      },
    });
    const updates = vi.fn();
    router.on("resource:update", updates);
    const loadResources = vi.spyOn(router, "loadResources").mockResolvedValue();
    router.startLive();

    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        rooms: [
          {
            op: "replace-item",
            id: 1,
            value: { id: 1, open: false },
          },
        ],
        summary: [{ op: "replace-resource", value: { count: 2 } }],
        unknown: [{ op: "replace-resource", value: "untrusted" }],
      },
    });
    await flushMicrotasks();

    expect(router.resourceStore.getSnapshot("rooms")).toEqual([
      { id: 1, open: false },
    ]);
    expect(router.resourceStore.getStateSnapshot("rooms")).toMatchObject({
      status: "ready",
      stale: true,
    });
    expect(router.resourceStore.getSnapshot("summary")).toBeUndefined();
    expect(router.resourceStore.getSnapshot("unknown")).toBeUndefined();
    expect(updates).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15);

    expect(loadResources).toHaveBeenCalledWith(
      ["rooms", "summary"],
      { url: "/rooms", reason: "live" }
    );
  });

  it("coalesces live patches and invalidations into one refresh batch", async () => {
    vi.useFakeTimers();
    const liveTransport = new ControlledLiveTransport();
    const router = new FluxRouter({
      liveTransport,
      liveBatchDelayMs: 10,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: {
          rooms: { version: "r1", value: [] },
          summary: { version: "s1", value: { count: 0 } },
        },
        live: ["rooms", "summary"],
      },
    });
    const loadResources = vi.spyOn(router, "loadResources").mockResolvedValue();
    router.startLive();
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: { rooms: [{ op: "append-item", value: { id: 1 } }] },
    });
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary", "rooms"],
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(10);

    expect(loadResources).toHaveBeenCalledOnce();
    expect(loadResources).toHaveBeenCalledWith(
      ["rooms", "summary"],
      { url: "/dashboard", reason: "live" }
    );
  });

  it("prevents an older deferred response from overwriting live work", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    const resolvers: Array<(envelope: PageEnvelope) => void> = [];
    transport.visitMock.mockImplementation(
      () => new Promise(resolve => { resolvers.push(resolve); })
    );
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 10,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["activity"],
        resources: {},
        deferred: ["activity"],
        live: ["activity"],
      },
    });
    router.startLive();
    const deferred = router.startInitialDeferred();
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["activity"],
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.visitMock).toHaveBeenCalledTimes(2);

    resolvers[0]({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { activity: { version: "old", value: ["old"] } },
    });
    await deferred;
    expect(router.resourceStore.getSnapshot("activity")).toBeUndefined();
    expect(router.resourceStore.getStateSnapshot("activity").status).toBe("loading");

    resolvers[1]({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { activity: { version: "new", value: ["new"] } },
    });
    await flushMicrotasks();
    expect(router.resourceStore.getRecord("activity")).toMatchObject({
      version: "new",
      value: ["new"],
    });
  });

  it("drops a deferred live response after navigation changes the page", async () => {
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveDeferred!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementation(request => {
      if (request.only) {
        return new Promise(resolve => { resolveDeferred = resolve; });
      }
      return Promise.resolve({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resources: {},
      });
    });
    const router = new FluxRouter({
      transport,
      liveTransport,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["activity"],
        resources: {},
        deferred: ["activity"],
        live: ["activity"],
      },
    });

    router.startLive();
    const deferred = router.startInitialDeferred();
    const deferredSignal = transport.visitMock.mock.calls[0][0].signal;
    await router.visit("/rooms");
    expect(deferredSignal?.aborted).toBe(true);
    expect(liveTransport.connections[0].signal.aborted).toBe(true);

    resolveDeferred({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { activity: { version: "old", value: ["old"] } },
    });
    await deferred;

    expect(router.pageStore.getSnapshot()).toMatchObject({
      component: "rooms/index",
      url: "/rooms",
    });
    expect(router.resourceStore.getSnapshot("activity")).toBeUndefined();
    expect(router.resourceStore.getStateSnapshot("activity").status).toBe("missing");
  });

  it("keeps a later mutation response over an older live refresh", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveLiveRefresh!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveLiveRefresh = resolve; })
    );
    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: {
        patches: {
          summary: [{ op: "replace-resource", value: { count: 3 } }],
        },
      },
    });
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 5,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });
    router.startLive();
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary"],
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5);
    await router.mutate("/summary/increment");

    resolveLiveRefresh({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { summary: { version: "old-live", value: { count: 2 } } },
    });
    await flushMicrotasks();

    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      data: { count: 3 },
      stale: true,
    });
  });

  it("lets a mutation response supersede a live event received mid-mutation", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveMutation!: (envelope: MutationEnvelope) => void;
    transport.mutateMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveMutation = resolve; })
    );
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 50,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });
    router.startLive();
    const mutation = router.mutate("/summary/increment");
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        summary: [{ op: "replace-resource", value: { count: 2 } }],
      },
    });
    await flushMicrotasks();
    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 2 });

    resolveMutation({
      protocol: "fluxfast/1",
      mutation: {
        patches: {
          summary: [{ op: "replace-resource", value: { count: 3 } }],
        },
      },
    });
    await mutation;

    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      data: { count: 3 },
      stale: true,
    });
    router.destroy();
  });

  it("keeps a live patch over an older retry response", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveRetry!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveRetry = resolve; })
    );
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 50,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });
    router.startLive();
    const retry = router.loadResources(["summary"], { reason: "retry" });
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        summary: [{ op: "replace-resource", value: { count: 2 } }],
      },
    });
    await flushMicrotasks();

    resolveRetry({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { summary: { version: "old-retry", value: { count: 0 } } },
    });
    await retry;

    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      data: { count: 2 },
      status: "ready",
      stale: true,
    });
    router.destroy();
  });

  it("keeps post-reconnect live work over an active older load", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveLoad!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveLoad = resolve; })
    );
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 50,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });
    router.startLive();
    const olderLoad = router.loadResources(["summary"], { reason: "refresh" });
    router.liveManager.reconnect();
    expect(liveTransport.connections).toHaveLength(2);
    liveTransport.connections[1].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        summary: [{ op: "replace-resource", value: { count: 4 } }],
      },
    });
    await flushMicrotasks();

    resolveLoad({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { summary: { version: "old", value: { count: 0 } } },
    });
    await olderLoad;

    expect(router.resourceStore.getStateSnapshot("summary")).toMatchObject({
      data: { count: 4 },
      stale: true,
    });
    router.destroy();
  });

  it("prevents old live refreshes from settling after navigation", async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const liveTransport = new ControlledLiveTransport();
    let resolveLiveRefresh!: (envelope: PageEnvelope) => void;
    transport.visitMock
      .mockImplementationOnce(
        () => new Promise(resolve => { resolveLiveRefresh = resolve; })
      )
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "reports/index", url: "/reports" },
        resources: {},
      });
    const router = new FluxRouter({
      transport,
      liveTransport,
      liveBatchDelayMs: 5,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        live: ["summary"],
      },
    });
    router.startLive();
    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "invalidate",
      keys: ["summary"],
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5);
    await router.visit("/reports");

    resolveLiveRefresh({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { summary: { version: "late", value: { count: 99 } } },
    });
    await flushMicrotasks();

    expect(router.pageStore.getSnapshot().url).toBe("/reports");
    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 1 });
    expect(router.resourceStore.isStale("summary")).toBe(true);
  });
});
