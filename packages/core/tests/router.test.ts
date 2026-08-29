import { describe, it, expect, vi } from "vitest";
import { FluxRouter } from "../src/router";
import { FluxTransport, VisitTransportRequest, MutationTransportRequest } from "../src/transport";
import { PageEnvelope, MutationEnvelope } from "../src/protocol";
import { HistoryManager } from "../src/history";

class MockTransport implements FluxTransport {
  public visitMock = vi.fn<[VisitTransportRequest], Promise<PageEnvelope>>();
  public mutateMock = vi.fn<[MutationTransportRequest], Promise<MutationEnvelope>>();

  async visit(req: VisitTransportRequest): Promise<PageEnvelope> {
    return this.visitMock(req);
  }

  async mutate(req: MutationTransportRequest): Promise<MutationEnvelope> {
    return this.mutateMock(req);
  }
}

describe("FluxRouter Core", () => {
  it("navigates and updates page and resource stores", async () => {
    const transport = new MockTransport();
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {
        rooms: { version: "v1", value: [{ id: 101 }] },
      },
    });

    const router = new FluxRouter({ transport });
    await router.visit("/rooms");

    expect(router.pageStore.getSnapshot().component).toBe("rooms/index");
    expect(router.resourceStore.getSnapshot("rooms")).toEqual([{ id: 101 }]);
  });

  it("loads resources without updating PageStore or history", async () => {
    const transport = new MockTransport();
    let resolveLoad!: (value: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveLoad = resolve; })
    );
    const router = new FluxRouter({
      transport,
      initialPage: { component: "rooms/index", url: "/rooms" },
      initialResources: {
        summary: { version: "v1", value: { count: 1 } },
      },
    });
    const originalPage = router.pageStore.getSnapshot();
    const pageSubscriber = vi.fn();
    router.pageStore.subscribe(pageSubscriber);
    const push = vi.spyOn(router.history, "push");
    const replace = vi.spyOn(router.history, "replace");

    const loading = router.loadResources(["summary"], {
      url: "/rooms",
      reason: "refresh",
    });

    expect(transport.visitMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "/rooms",
      knownVersions: { summary: "v1" },
      only: ["summary"],
    }));
    expect(router.resourceStore.getStateSnapshot("summary")).toEqual({
      data: { count: 1 },
      status: "loading",
      error: null,
      stale: true,
    });

    resolveLoad({
      protocol: "fluxfast/1",
      page: { component: "ignored/index", url: "/ignored" },
      resources: { summary: { version: "v2", value: { count: 2 } } },
    });
    await loading;

    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 2 });
    expect(router.resourceStore.getStateSnapshot("summary").status).toBe("ready");
    expect(router.pageStore.getSnapshot()).toBe(originalPage);
    expect(pageSubscriber).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("applies mixed resource results and settles unchanged known resources", async () => {
    const transport = new MockTransport();
    const router = new FluxRouter({
      transport,
      initialPage: { component: "dashboard/index", url: "/dashboard" },
      initialResources: {
        summary: { version: "v1", value: { count: 1 } },
      },
    });
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: {
        analytics: { version: "a1", value: { revenue: 95_000 } },
      },
      resourceErrors: {
        activity: {
          type: "ResourceError",
          message: "A deferred resource could not be resolved",
        },
      },
    });

    await router.loadResources(["summary", "analytics", "activity"], {
      reason: "deferred",
    });

    expect(router.resourceStore.getStateSnapshot("summary")).toEqual({
      data: { count: 1 },
      status: "ready",
      error: null,
      stale: false,
    });
    expect(router.resourceStore.getStateSnapshot("analytics")).toMatchObject({
      data: { revenue: 95_000 },
      status: "ready",
      error: null,
    });
    expect(router.resourceStore.getStateSnapshot("activity")).toMatchObject({
      status: "error",
      error: {
        type: "ResourceError",
        message: "A deferred resource could not be resolved",
      },
    });
  });

  it("routes selective refresh through resource-only loading", async () => {
    const router = new FluxRouter({
      transport: new MockTransport(),
      initialPage: { component: "rooms/index", url: "/rooms" },
    });
    const loadResources = vi
      .spyOn(router, "loadResources")
      .mockResolvedValue(undefined);

    await router.refresh({ only: ["summary", "rooms"] });

    expect(loadResources).toHaveBeenCalledWith(
      ["summary", "rooms"],
      { url: "/rooms", reason: "refresh" }
    );
  });

  it("marks resource-only transport failures as retryable resource errors", async () => {
    const transport = new MockTransport();
    transport.visitMock.mockRejectedValueOnce(new Error("Network unavailable"));
    const router = new FluxRouter({
      transport,
      initialPage: { component: "dashboard/index", url: "/dashboard" },
    });

    await expect(router.loadResources(["analytics", "activity"], {
      reason: "deferred",
    })).rejects.toThrow("Network unavailable");

    for (const key of ["analytics", "activity"]) {
      expect(router.resourceStore.getStateSnapshot(key)).toMatchObject({
        status: "error",
        error: { type: "Error", message: "Network unavailable" },
      });
    }
  });

  it("initializes deferred state without loading until idempotent startup", async () => {
    const transport = new MockTransport();
    let resolveDeferred!: (value: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveDeferred = resolve; })
    );
    const router = new FluxRouter({
      transport,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["summary", "analytics"],
        resources: { summary: { version: "s1", value: { count: 1 } } },
        deferred: ["analytics"],
      },
    });

    expect(transport.visitMock).not.toHaveBeenCalled();
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("pending");

    const first = router.startInitialDeferred();
    const second = router.startInitialDeferred();
    expect(second).toBe(first);
    expect(transport.visitMock).toHaveBeenCalledTimes(1);
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("loading");

    resolveDeferred({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { analytics: { version: "a1", value: { revenue: 95_000 } } },
    });
    await first;
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("ready");
  });

  it("finishes navigation before its deferred resource batch", async () => {
    const transport = new MockTransport();
    let resolveDeferred!: (value: PageEnvelope) => void;
    transport.visitMock
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: {},
        deferred: ["analytics", "activity"],
      })
      .mockImplementationOnce(
        () => new Promise(resolve => { resolveDeferred = resolve; })
      );
    const router = new FluxRouter({ transport });

    await router.visit("/dashboard");

    expect(router.pageStore.getSnapshot().component).toBe("dashboard/index");
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("loading");
    expect(transport.visitMock.mock.calls[1][0].only).toEqual([
      "analytics",
      "activity",
    ]);

    resolveDeferred({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: {
        analytics: { version: "a1", value: { revenue: 95_000 } },
        activity: { version: "ac1", value: [] },
      },
    });
    await vi.waitFor(() => {
      expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("ready");
    });
  });

  it("keeps prefetch lightweight and starts deferred loading on actual visit", async () => {
    const transport = new MockTransport();
    transport.visitMock
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
        deferred: ["analytics"],
      })
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { analytics: { version: "a1", value: { revenue: 95_000 } } },
      });
    const router = new FluxRouter({ transport });

    await router.prefetch("/dashboard");
    expect(transport.visitMock).toHaveBeenCalledTimes(1);
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("missing");

    await router.visit("/dashboard");
    expect(transport.visitMock).toHaveBeenCalledTimes(2);
    expect(transport.visitMock.mock.calls[1][0].only).toEqual(["analytics"]);
    await vi.waitFor(() => {
      expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("ready");
    });
  });

  it("lets the newest overlapping resource request win", async () => {
    const transport = new MockTransport();
    const resolvers: Array<(value: PageEnvelope) => void> = [];
    transport.visitMock.mockImplementation(
      () => new Promise(resolve => { resolvers.push(resolve); })
    );
    const router = new FluxRouter({
      transport,
      initialPage: { component: "dashboard/index", url: "/dashboard" },
    });

    const older = router.loadResources(["analytics"], { reason: "refresh" });
    const newer = router.loadResources(["analytics"], { reason: "retry" });
    resolvers[1]({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { analytics: { version: "v2", value: { value: 2 } } },
    });
    await newer;
    resolvers[0]({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { analytics: { version: "v1", value: { value: 1 } } },
    });
    await older;

    expect(router.resourceStore.getRecord("analytics")?.version).toBe("v2");
  });

  it("aborts the active deferred batch when navigation changes", async () => {
    const transport = new MockTransport();
    let resolveOldDeferred!: (value: PageEnvelope) => void;
    transport.visitMock.mockImplementation(req => {
      if (req.only) {
        return new Promise(resolve => { resolveOldDeferred = resolve; });
      }
      if (req.url === "/dashboard") {
        return Promise.resolve({
          protocol: "fluxfast/1",
          page: { component: "dashboard/index", url: "/dashboard" },
          resources: {},
          deferred: ["analytics"],
        });
      }
      return Promise.resolve({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resources: {},
      });
    });
    const router = new FluxRouter({ transport });

    await router.visit("/dashboard");
    const deferredSignal = transport.visitMock.mock.calls[1][0].signal;
    await router.visit("/rooms");
    expect(deferredSignal?.aborted).toBe(true);

    resolveOldDeferred({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { analytics: { version: "old", value: { value: "old" } } },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(router.resourceStore.getSnapshot("analytics")).toBeUndefined();
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("missing");
  });

  it("prevents a pre-mutation resource response from becoming canonical", async () => {
    const transport = new MockTransport();
    let resolveResource!: (value: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveResource = resolve; })
    );
    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: { invalidate: ["analytics"] },
    });
    const router = new FluxRouter({
      transport,
      initialPage: { component: "dashboard/index", url: "/dashboard" },
    });

    const loading = router.loadResources(["analytics"], { reason: "deferred" });
    await router.mutate("/analytics/recalculate");
    resolveResource({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { analytics: { version: "old", value: { value: "old" } } },
    });
    await loading;

    expect(router.resourceStore.getSnapshot("analytics")).toBeUndefined();
  });

  it("keeps a mutation patch when an older resource load resolves later", async () => {
    const transport = new MockTransport();
    let resolveOlderLoad!: (value: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveOlderLoad = resolve; })
    );
    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: {
        patches: {
          analytics: [
            { op: "replace-resource", value: { revenue: 120_000 } },
          ],
        },
      },
    });
    const router = new FluxRouter({
      transport,
      initialPage: { component: "dashboard/index", url: "/dashboard" },
      initialResources: {
        analytics: { version: "a1", value: { revenue: 95_000 } },
      },
    });

    const olderLoad = router.loadResources(["analytics"], {
      reason: "deferred",
    });
    await router.mutate("/analytics/recalculate");

    expect(router.resourceStore.getStateSnapshot("analytics")).toMatchObject({
      data: { revenue: 120_000 },
      status: "ready",
      stale: true,
    });

    resolveOlderLoad({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: {
        analytics: { version: "a-old", value: { revenue: 90_000 } },
      },
    });
    await olderLoad;

    expect(router.resourceStore.getStateSnapshot("analytics")).toMatchObject({
      data: { revenue: 120_000 },
      status: "ready",
      stale: true,
    });
  });

  it("supersedes a pending deferred load with mutation revalidation", async () => {
    const transport = new MockTransport();
    let resolveOlderLoad!: (value: PageEnvelope) => void;
    let resolveRevalidation!: (value: PageEnvelope) => void;
    transport.visitMock
      .mockImplementationOnce(
        () => new Promise(resolve => { resolveOlderLoad = resolve; })
      )
      .mockImplementationOnce(
        () => new Promise(resolve => { resolveRevalidation = resolve; })
      );
    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: { invalidate: ["analytics"] },
    });
    const router = new FluxRouter({
      transport,
      initialPage: { component: "dashboard/index", url: "/dashboard" },
    });
    const unsubscribe = router.resourceStore.subscribe("analytics", () => {});

    const olderLoad = router.loadResources(["analytics"], {
      reason: "deferred",
    });
    const mutation = router.mutate("/analytics/recalculate");

    await vi.waitFor(() => {
      expect(transport.visitMock).toHaveBeenCalledTimes(2);
    });
    expect(router.resourceStore.getStateSnapshot("analytics")).toEqual({
      data: undefined,
      status: "loading",
      error: null,
      stale: false,
    });

    resolveOlderLoad({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: {
        analytics: { version: "a-old", value: { revenue: 90_000 } },
      },
    });
    await olderLoad;
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe(
      "loading"
    );

    resolveRevalidation({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: {
        analytics: { version: "a2", value: { revenue: 120_000 } },
      },
    });
    await mutation;

    expect(router.resourceStore.getRecord("analytics")).toMatchObject({
      version: "a2",
      value: { revenue: 120_000 },
    });
    unsubscribe();
  });

  it("caches only an envelope's explicit resource manifest", async () => {
    const transport = new MockTransport();
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resourceKeys: ["summary"],
      resources: { summary: { version: "s1", value: { count: 1 } } },
    });
    const router = new FluxRouter({ transport });
    router.resourceStore.set({ key: "unrelated", version: "u1", value: true });

    await router.visit("/dashboard");

    expect(router.pageCache.getValid("/dashboard", router.resourceStore))
      .toMatchObject({
        resources: { summary: "s1" },
        resourceKeys: ["summary"],
      });
  });

  it("restores pending deferred state and restarts its batch on back navigation", async () => {
    const history = new HistoryManager();
    let popState!: (url: string) => void;
    vi.spyOn(history, "onPopState").mockImplementation(callback => {
      popState = callback;
      return () => undefined;
    });
    const transport = new MockTransport();
    let resolveDeferred!: (envelope: PageEnvelope) => void;
    transport.visitMock
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["summary", "analytics"],
        resources: { summary: { version: "s1", value: { count: 1 } } },
        deferred: ["analytics"],
      })
      .mockImplementationOnce(
        () => new Promise(resolve => { resolveDeferred = resolve; })
      )
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resourceKeys: [],
        resources: {},
      })
      .mockImplementationOnce(
        () => new Promise(() => undefined)
      );
    const router = new FluxRouter({ transport, history, deferHistory: true });
    router.startHistory();

    await router.visit("/dashboard");
    await router.visit("/rooms");
    resolveDeferred({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { analytics: { version: "old", value: { old: true } } },
    });
    await Promise.resolve();

    popState("/dashboard");

    expect(router.pageStore.getSnapshot().component).toBe("dashboard/index");
    expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("loading");
    expect(transport.visitMock.mock.calls[3][0]).toMatchObject({
      url: "/dashboard",
      only: ["analytics"],
    });
  });

  it("restores a page with a resolved deferred resource without reloading it", async () => {
    const history = new HistoryManager();
    let popState!: (url: string) => void;
    vi.spyOn(history, "onPopState").mockImplementation(callback => {
      popState = callback;
      return () => undefined;
    });
    const transport = new MockTransport();
    transport.visitMock
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["summary", "analytics"],
        resources: { summary: { version: "s1", value: { count: 1 } } },
        deferred: ["analytics"],
      })
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { analytics: { version: "a1", value: { revenue: 95_000 } } },
      })
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resourceKeys: [],
        resources: {},
      });
    const router = new FluxRouter({ transport, history, deferHistory: true });
    router.startHistory();

    await router.visit("/dashboard");
    await vi.waitFor(() => {
      expect(router.resourceStore.getStateSnapshot("analytics").status).toBe("ready");
    });
    await router.visit("/rooms");
    popState("/dashboard");

    expect(router.pageStore.getSnapshot().component).toBe("dashboard/index");
    expect(router.resourceStore.getSnapshot("analytics")).toEqual({ revenue: 95_000 });
    expect(transport.visitMock).toHaveBeenCalledTimes(3);
  });

  it("restores valid cached pages across back and forward navigation", async () => {
    const history = new HistoryManager();
    let popState!: (url: string) => void;
    vi.spyOn(history, "onPopState").mockImplementation(callback => {
      popState = callback;
      return () => undefined;
    });
    const transport = new MockTransport();
    transport.visitMock
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resourceKeys: ["summary"],
        resources: { summary: { version: "s1", value: { count: 1 } } },
      })
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resourceKeys: ["rooms"],
        resources: { rooms: { version: "r1", value: [] } },
      });
    const router = new FluxRouter({ transport, history, deferHistory: true });
    router.startHistory();

    await router.visit("/dashboard");
    await router.visit("/rooms");

    popState("/dashboard");
    expect(router.pageStore.getSnapshot().component).toBe("dashboard/index");

    popState("/rooms");
    expect(router.pageStore.getSnapshot().component).toBe("rooms/index");
    expect(transport.visitMock).toHaveBeenCalledTimes(2);
  });

  it("handles race condition: latest navigation wins (Section 27)", async () => {
    const transport = new MockTransport();
    const router = new FluxRouter({ transport });

    // Visit A: slow (resolves in 50ms)
    let resolveVisitA: (val: PageEnvelope) => void;
    const visitAPromise = new Promise<PageEnvelope>((resolve) => {
      resolveVisitA = resolve;
    });

    // Visit B: fast (resolves immediately)
    const visitBResponse: PageEnvelope = {
      protocol: "fluxfast/1",
      page: { component: "reservations/index", url: "/reservations" },
      resources: {
        reservations: { version: "res1", value: [{ id: 1 }] },
      },
    };

    transport.visitMock.mockImplementation((req) => {
      if (req.url === "/rooms") {
        return visitAPromise;
      }
      return Promise.resolve(visitBResponse);
    });

    // Start visit A
    const navA = router.visit("/rooms");

    // 10ms later, start visit B
    const navB = router.visit("/reservations");

    // Wait for B to finish
    await navB;
    expect(router.pageStore.getSnapshot().component).toBe("reservations/index");

    // Now resolve the older A response
    resolveVisitA!({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {
        rooms: { version: "rooms1", value: [] },
      },
    });

    await navA;

    // MUST remain at /reservations, NOT overwritten by the older /rooms response!
    expect(router.pageStore.getSnapshot().component).toBe("reservations/index");
    expect(router.pageStore.getSnapshot().url).toBe("/reservations");
  });

  it("handles mutations and invalidations", async () => {
    const transport = new MockTransport();
    const router = new FluxRouter({ transport });

    router.resourceStore.set({
      key: "rooms",
      version: "v1",
      value: [{ id: 101, status: "dirty" }],
    });
    router.resourceStore.set({
      key: "summary",
      version: "v1",
      value: { count: 1 },
    });

    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: {
        patches: {
          rooms: [
            {
              op: "replace-item",
              id: 101,
              value: { id: 101, status: "clean" },
            },
          ],
        },
        invalidate: ["summary"],
      },
    });

    await router.mutate("/rooms/101/clean");

    expect(router.resourceStore.getSnapshot<any[]>("rooms")).toEqual([
      { id: 101, status: "clean" },
    ]);
    expect(router.resourceStore.getSnapshot("summary")).toBeUndefined(); // Invalidated!
  });

  it("revalidates only invalidated resources with active subscribers", async () => {
    const transport = new MockTransport();
    let resolveRevalidation!: (value: PageEnvelope) => void;
    const router = new FluxRouter({
      transport,
      initialPage: { component: "rooms/index", url: "/rooms" },
    });
    router.resourceStore.set({ key: "summary", version: "v1", value: { count: 1 } });
    const unsubscribe = router.resourceStore.subscribe("summary", () => {});
    const loadResources = vi.spyOn(router, "loadResources");
    const originalPage = router.pageStore.getSnapshot();
    const push = vi.spyOn(router.history, "push");
    const replace = vi.spyOn(router.history, "replace");

    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: { invalidate: ["summary"] },
    });
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveRevalidation = resolve; })
    );

    const mutation = router.mutate("/rooms/refresh-summary");

    await vi.waitFor(() => {
      expect(transport.visitMock).toHaveBeenCalledTimes(1);
    });
    expect(loadResources).toHaveBeenCalledWith(["summary"], {
      url: "/rooms",
      reason: "mutation",
    });
    expect(transport.visitMock.mock.calls[0][0]).toMatchObject({
      url: "/rooms",
      only: ["summary"],
      knownVersions: {},
    });
    expect(router.resourceStore.getStateSnapshot("summary")).toEqual({
      data: { count: 1 },
      status: "loading",
      error: null,
      stale: true,
    });

    resolveRevalidation({
      protocol: "fluxfast/1",
      page: { component: "ignored/index", url: "/ignored" },
      resources: { summary: { version: "v2", value: { count: 2 } } },
    });
    await mutation;

    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 2 });
    expect(router.resourceStore.getStateSnapshot("summary").stale).toBe(false);
    expect(router.pageStore.getSnapshot()).toBe(originalPage);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("deduplicates an in-flight prefetch when navigation starts", async () => {
    const transport = new MockTransport();
    const router = new FluxRouter({ transport });
    let resolveRequest!: (value: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveRequest = resolve; })
    );

    const prefetch = router.prefetch("/rooms");
    const visit = router.visit("/rooms");
    expect(transport.visitMock).toHaveBeenCalledTimes(1);

    resolveRequest({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: { rooms: { version: "v1", value: [] } },
    });
    await Promise.all([prefetch, visit]);
    expect(router.pageStore.getSnapshot().component).toBe("rooms/index");
  });

  it("honors external redirects from mutation envelopes", async () => {
    const transport = new MockTransport();
    const hardNavigate = vi.fn();
    const router = new FluxRouter({ transport, hardNavigate });
    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: { externalRedirect: "https://example.com/login" },
    });

    await router.mutate("/logout");
    expect(hardNavigate).toHaveBeenCalledWith("https://example.com/login");
  });
});
