import { describe, expect, it, vi } from "vitest";
import type {
  FluxDiagnosticEvent,
  FluxDiagnosticsHub,
} from "../src/diagnostics";
import type { MutationEnvelope, PageEnvelope } from "../src/protocol";
import { FluxRouter } from "../src/router";
import type {
  FluxTransport,
  MutationTransportRequest,
  VisitTransportRequest,
} from "../src/transport";

class MockTransport implements FluxTransport {
  public diagnostics?: FluxDiagnosticsHub;
  public readonly visitMock = vi.fn<
    (request: VisitTransportRequest) => Promise<PageEnvelope>
  >();
  public readonly mutateMock = vi.fn<
    (request: MutationTransportRequest) => Promise<MutationEnvelope>
  >();

  attachDiagnostics(diagnostics: FluxDiagnosticsHub): void {
    this.diagnostics = diagnostics;
  }

  visit(request: VisitTransportRequest): Promise<PageEnvelope> {
    return this.visitMock(request);
  }

  mutate(request: MutationTransportRequest): Promise<MutationEnvelope> {
    return this.mutateMock(request);
  }
}

function payload(event: FluxDiagnosticEvent): Record<string, unknown> {
  return event.data as Record<string, unknown>;
}

describe("FluxRouter diagnostics", () => {
  it("does no diagnostic emission work while the hub is inactive", async () => {
    const transport = new MockTransport();
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {},
    });
    const router = new FluxRouter({ transport, deferHistory: true });
    const emit = vi.spyOn(router.diagnostics, "emit");

    expect(router.diagnostics.active).toBe(false);
    expect(transport.diagnostics).toBe(router.diagnostics);
    await router.visit("/rooms");

    expect(emit).not.toHaveBeenCalled();
    router.destroy();
  });

  it("correlates navigation, cache, and resource observations without values or query data", async () => {
    const transport = new MockTransport();
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms?token=server-secret" },
      resources: {
        rooms: {
          version: "rooms-v1",
          value: { privateValue: "must-not-leak" },
        },
      },
      resourceKeys: ["rooms"],
    });
    const router = new FluxRouter({ transport, deferHistory: true });
    const events: FluxDiagnosticEvent[] = [];
    router.diagnostics.subscribe(event => events.push(event));

    await router.visit("/rooms?token=client-secret");

    const navigation = events.filter(event => event.type === "navigation");
    expect(navigation.map(event => payload(event).phase)).toEqual([
      "start",
      "success",
    ]);
    expect(navigation[0].correlationId).toMatch(/^visit_/);
    expect(navigation[1].correlationId).toBe(navigation[0].correlationId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "page-cache",
        correlationId: navigation[0].correlationId,
        data: expect.objectContaining({ action: "miss", url: "/rooms" }),
      }),
      expect.objectContaining({
        type: "page-cache",
        correlationId: navigation[0].correlationId,
        data: expect.objectContaining({ action: "write", url: "/rooms" }),
      }),
      expect.objectContaining({
        type: "resource-update",
        correlationId: navigation[0].correlationId,
        data: {
          key: "rooms",
          version: "rooms-v1",
          source: "navigation",
        },
      }),
    ]));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain("server-secret");
    expect(serialized).not.toContain("must-not-leak");
    router.destroy();
  });

  it("bounds resource metadata and emits only an error category", async () => {
    const transport = new MockTransport();
    const failure = new Error("authorization bearer secret");
    failure.name = "UpstreamUnavailable";
    transport.visitMock.mockRejectedValueOnce(failure);
    const router = new FluxRouter({ transport, deferHistory: true });
    const events: FluxDiagnosticEvent[] = [];
    router.diagnostics.subscribe(event => events.push(event));
    const keys = Array.from({ length: 105 }, (_, index) => `resource-${index}`);

    await expect(router.loadResources(keys, {
      url: "/dashboard?access_token=secret",
      reason: "refresh",
    })).rejects.toBe(failure);

    const lifecycle = events.filter(event => event.type === "resource-load");
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0].correlationId).toMatch(/^resource_refresh_/);
    expect(lifecycle[1].correlationId).toBe(lifecycle[0].correlationId);
    expect(payload(lifecycle[0])).toMatchObject({
      phase: "start",
      url: "/dashboard",
      keyCount: 105,
      keysTruncated: true,
    });
    expect(payload(lifecycle[0]).keys).toHaveLength(100);
    expect(payload(lifecycle[1])).toMatchObject({
      phase: "error",
      errorType: "UpstreamUnavailable",
    });
    expect(JSON.stringify(events)).not.toContain("bearer secret");
    expect(JSON.stringify(events)).not.toContain("access_token");
    router.destroy();
  });

  it("observes mutation, prefetch, deferred, and lifecycle work without request bodies", async () => {
    const transport = new MockTransport();
    transport.mutateMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      mutation: {
        patches: {
          summary: [{ op: "replace-resource", value: { hidden: "response-secret" } }],
        },
        invalidate: ["activity"],
      },
    });
    transport.visitMock
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "reports/index", url: "/reports" },
        resources: {},
      })
      .mockResolvedValueOnce({
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { activity: { version: "a1", value: ["private"] } },
      });
    const router = new FluxRouter({
      transport,
      deferHistory: true,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: {
          summary: { version: "s1", value: { count: 1 } },
        },
        deferred: ["activity"],
      },
    });
    const events: FluxDiagnosticEvent[] = [];
    router.diagnostics.subscribe(event => events.push(event));

    await router.mutate("/summary?token=secret", { password: "request-secret" });
    const mutationCorrelationId = events.find(event => (
      event.type === "mutation" && payload(event).phase === "start"
    ))?.correlationId;
    expect(transport.mutateMock).toHaveBeenCalledWith(expect.objectContaining({
      diagnosticCorrelationId: mutationCorrelationId,
    }));
    await router.prefetch("/reports?token=prefetch-secret");
    await router.startInitialDeferred();
    router.clear();
    router.destroy();

    for (const type of ["mutation", "prefetch", "deferred"] as const) {
      const observations = events.filter(event => event.type === type);
      expect(observations.map(event => payload(event).phase)).toEqual([
        "start",
        "success",
      ]);
      expect(observations[0].correlationId).toBeDefined();
      expect(observations[1].correlationId).toBe(observations[0].correlationId);
    }
    expect(events.filter(event => event.type === "lifecycle")
      .map(event => payload(event).phase)).toEqual(["clear", "destroy"]);
    expect(router.diagnostics.active).toBe(false);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("request-secret");
    expect(serialized).not.toContain("response-secret");
    expect(serialized).not.toContain("prefetch-secret");
  });
});
