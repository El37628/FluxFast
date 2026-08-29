import { describe, it, expect, vi } from "vitest";
import { FluxRouter } from "../src/router";
import { FluxTransport, VisitTransportRequest, MutationTransportRequest } from "../src/transport";
import { PageEnvelope, MutationEnvelope } from "../src/protocol";

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
    const router = new FluxRouter({
      transport,
      initialPage: { component: "rooms/index", url: "/rooms" },
    });
    router.resourceStore.set({ key: "summary", version: "v1", value: { count: 1 } });
    const unsubscribe = router.resourceStore.subscribe("summary", () => {});

    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: { invalidate: ["summary"] },
    });
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: { summary: { version: "v2", value: { count: 2 } } },
    });

    await router.mutate("/rooms/refresh-summary");

    expect(transport.visitMock).toHaveBeenCalledTimes(1);
    expect(transport.visitMock.mock.calls[0][0].only).toEqual(["summary"]);
    expect(router.resourceStore.getSnapshot("summary")).toEqual({ count: 2 });
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
