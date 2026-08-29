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
