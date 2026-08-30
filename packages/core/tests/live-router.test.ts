import { afterEach, describe, expect, it, vi } from "vitest";
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
});
