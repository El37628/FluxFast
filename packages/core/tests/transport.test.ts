import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assertPageEnvelope,
  assertMutationEnvelope,
  encodeKnownVersions,
  FetchTransport,
} from "../src/transport";
import { MutationError, ProtocolError, ValidationError } from "../src/errors";
import { HEADER_CAPABILITIES, serializeCapabilities } from "../src/capabilities";
import { HEADER_CLIENT_ID } from "../src/live/transport";
import {
  FluxDiagnosticsHub,
  type FluxDiagnosticEvent,
} from "../src/diagnostics";

const HEADER_DEVTOOLS = "X-FluxFast-DevTools";
const HEADER_DEVTOOLS_TRACE = "X-FluxFast-DevTools-Trace";

function encodeTrace(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function pageTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "fluxfast-devtools/1",
    requestId: "ffdev_0123456789abcdef",
    type: "page",
    durationMs: 4.5,
    pageMs: 1,
    resourcesMs: 2,
    serializeMs: 0.5,
    resources: [{
      key: "rooms",
      result: "loader",
      durationMs: 2,
      scope: "tenant",
      ttl: 60,
      deferred: false,
      live: true,
      cacheBackend: "memory",
      cacheResult: "miss",
      sent: true,
      knownVersion: false,
      cacheMs: 0.1,
      loaderMs: 1.8,
    }],
    truncated: false,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("FetchTransport", () => {
  it("advertises capabilities on visits and mutations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resources: {},
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: "fluxfast/1",
        mutation: {},
      }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();

    await transport.visit({ url: "/rooms", visitId: "visit_1" });
    await transport.mutate({ url: "/rooms", data: {}, clientId: "ff_tab" });

    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        [HEADER_CAPABILITIES]: serializeCapabilities(),
      });
    }
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      [HEADER_CLIENT_ID]: "ff_tab",
    });
  });

  it("sends no DevTools opt-in without a diagnostic subscriber", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {},
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();
    transport.attachDiagnostics(new FluxDiagnosticsHub());

    await transport.visit({
      url: "/rooms",
      visitId: "visit_inactive",
      headers: { "x-fluxfast-devtools": "1" },
    });

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(HEADER_DEVTOOLS))
      .toBeNull();
  });

  it("correlates browser timing with one validated server trace", async () => {
    const trace = pageTrace();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {},
    }), {
      headers: {
        "content-type": "application/json",
        [HEADER_DEVTOOLS_TRACE]: encodeTrace(trace),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();
    const hub = new FluxDiagnosticsHub();
    const events: FluxDiagnosticEvent[] = [];
    hub.subscribe(event => events.push(event));
    transport.attachDiagnostics(hub);

    await transport.visit({
      url: "/rooms?token=request-secret",
      visitId: "visit_correlated",
      knownVersions: {
        rooms: "rooms-v1",
        "bad\u007fkey": "unsafe-version",
      },
      only: ["rooms", "bad\u007fkey"],
    });

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(HEADER_DEVTOOLS))
      .toBe("1");
    expect(events.map(event => event.type)).toEqual([
      "transport",
      "server-trace",
      "transport",
    ]);
    expect(events.every(event => event.correlationId === "visit_correlated"))
      .toBe(true);
    expect(events[0].data).toEqual({
      phase: "start",
      requestType: "page",
      method: "GET",
      path: "/rooms",
      protocol: "fluxfast/1",
      capabilities: ["deferred-resources", "live-resources"],
      knownVersions: [{ key: "rooms", version: "rooms-v1" }],
      only: ["rooms"],
    });
    expect(events[1].data).toEqual(trace);
    expect(events[2].data).toMatchObject({
      phase: "success",
      requestType: "page",
      method: "GET",
      path: "/rooms",
      status: 200,
      serverTrace: "valid",
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(events)).not.toContain("request-secret");
    expect(JSON.stringify(events)).not.toContain("unsafe-version");
  });

  it("rejects unsafe or oversized traces without breaking the application response", async () => {
    const unsafeTrace = pageTrace({
      authorization: "Bearer server-secret",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/unsafe" },
        resources: {},
      }), {
        headers: {
          "content-type": "application/json",
          [HEADER_DEVTOOLS_TRACE]: encodeTrace(unsafeTrace),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/oversized" },
        resources: {},
      }), {
        headers: {
          "content-type": "application/json",
          [HEADER_DEVTOOLS_TRACE]: "A".repeat(7 * 1024 + 1),
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();
    const hub = new FluxDiagnosticsHub();
    const events: FluxDiagnosticEvent[] = [];
    hub.subscribe(event => events.push(event));
    transport.attachDiagnostics(hub);

    await expect(transport.visit({ url: "/unsafe", visitId: "visit_unsafe" }))
      .resolves.toMatchObject({ page: { url: "/unsafe" } });
    await expect(transport.visit({ url: "/oversized", visitId: "visit_large" }))
      .resolves.toMatchObject({ page: { url: "/oversized" } });

    expect(events.filter(event => event.type === "server-trace")).toEqual([]);
    expect(events.filter(event => (
      event.type === "transport" &&
      (event.data as { phase?: string }).phase === "success"
    )).map(event => event.data)).toEqual([
      expect.objectContaining({ serverTrace: "invalid" }),
      expect.objectContaining({ serverTrace: "invalid" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("server-secret");
  });

  it("reports an unsupported diagnostic protocol without failing the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {},
    }), {
      headers: {
        "content-type": "application/json",
        [HEADER_DEVTOOLS_TRACE]: encodeTrace(pageTrace({
          protocol: "fluxfast-devtools/2",
        })),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();
    const hub = new FluxDiagnosticsHub();
    const events: FluxDiagnosticEvent[] = [];
    hub.subscribe(event => events.push(event));
    transport.attachDiagnostics(hub);

    await expect(transport.visit({
      url: "/rooms",
      visitId: "visit_unsupported",
    })).resolves.toMatchObject({ page: { url: "/rooms" } });

    expect(events.filter(event => event.type === "server-trace")).toEqual([]);
    expect(events.at(-1)?.data).toMatchObject({
      phase: "success",
      serverTrace: "unsupported",
      serverTraceProtocol: "fluxfast-devtools/2",
    });
  });

  it("emits a safe transport failure without URL query or error message data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("authorization token must stay private"), {
        name: "NetworkError",
      })
    ));
    const transport = new FetchTransport();
    const hub = new FluxDiagnosticsHub();
    const events: FluxDiagnosticEvent[] = [];
    hub.subscribe(event => events.push(event));
    transport.attachDiagnostics(hub);

    await expect(transport.visit({
      url: "/rooms?authorization=secret",
      visitId: "visit_failure",
    })).rejects.toThrow("authorization token must stay private");

    expect(events.at(-1)).toMatchObject({
      type: "transport",
      correlationId: "visit_failure",
      data: {
        phase: "error",
        requestType: "page",
        method: "GET",
        path: "/rooms",
        durationMs: expect.any(Number),
        serverTrace: "missing",
        errorType: "NetworkError",
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("authorization=secret");
    expect(serialized).not.toContain("token must stay private");
  });

  it("uses the router mutation correlation ID for transport and server events", async () => {
    const trace = {
      protocol: "fluxfast-devtools/1",
      requestId: "ffdev_abcdef0123456789",
      type: "mutation",
      durationMs: 3,
      handlerMs: 1,
      invalidationMs: 1,
      serializeMs: 0.2,
      patches: [{ key: "rooms", operations: { "merge-object": 1 } }],
      invalidated: ["summary"],
      invalidationCount: 1,
      liveSignals: 1,
      redirect: "none",
      truncated: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: "fluxfast/1",
      mutation: {},
    }), {
      headers: {
        "content-type": "application/json",
        [HEADER_DEVTOOLS_TRACE]: encodeTrace(trace),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();
    const hub = new FluxDiagnosticsHub();
    const events: FluxDiagnosticEvent[] = [];
    hub.subscribe(event => events.push(event));
    transport.attachDiagnostics(hub);

    await transport.mutate({
      url: "/rooms",
      data: { password: "body-secret" },
      diagnosticCorrelationId: "mutation_1",
    });

    expect(events.map(event => event.correlationId)).toEqual([
      "mutation_1",
      "mutation_1",
      "mutation_1",
    ]);
    expect(events[1]).toMatchObject({ type: "server-trace", data: trace });
    expect(JSON.stringify(events)).not.toContain("body-secret");
  });

  it("rejects invalid mutation client identities before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new FetchTransport().mutate({
      url: "/rooms",
      clientId: "contains space",
    })).rejects.toThrowError(/client ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes unicode known-resource metadata as base64url", () => {
    const encoded = encodeKnownVersions({ "hôtel": "版本-1" });
    expect(encoded).toBeDefined();
    const decoded = Buffer.from(encoded!, "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ "hôtel": "版本-1" });
  });

  it("omits known metadata that exceeds the decoded safety limit", () => {
    const known = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `resource-${index}-${"x".repeat(100)}`,
        "v".repeat(128),
      ])
    );
    expect(encodeKnownVersions(known)).toBeUndefined();
  });

  it("omits control-character metadata from known-resource headers", () => {
    const encoded = encodeKnownVersions({
      rooms: "v1",
      "bad\u007fkey": "v2",
      summary: "v3\u009f",
    });

    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")))
      .toEqual({ rooms: "v1" });
    expect(encodeKnownVersions({ rooms: null as unknown as string }))
      .toBeUndefined();
  });

  it("bounds and filters partial-resource request headers", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => (
      new Response(JSON.stringify({
        protocol: "fluxfast/1",
        page: { component: "rooms/index", url: "/rooms" },
        resources: {},
      }), { headers: { "content-type": "application/json" } })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();

    await transport.visit({
      url: "/rooms",
      visitId: "visit_safe",
      only: ["rooms", "bad\u007fkey", null as unknown as string],
    });
    await transport.visit({
      url: "/rooms",
      visitId: "visit_oversized",
      only: Array.from({ length: 100 }, () => "\u754c".repeat(128)),
    });

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-FluxFast-Only"))
      .toBe("rooms");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("X-FluxFast-Only"))
      .toBeNull();
  });

  it("rejects malformed page envelopes", () => {
    expect(() => assertPageEnvelope({ protocol: "fluxfast/1", resources: {} }))
      .toThrowError(ProtocolError);
  });

  it("accepts old and additive resource metadata page envelopes", () => {
    expect(() => assertPageEnvelope({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {},
    })).not.toThrow();

    expect(() => assertPageEnvelope({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resourceKeys: ["rooms", "analytics", "activity"],
      resources: {},
      deferred: ["analytics"],
      live: ["rooms", "analytics"],
      resourceErrors: {
        activity: {
          type: "ResourceError",
          message: "A deferred resource could not be resolved",
        },
      },
    })).not.toThrow();
  });

  it.each([
    ["resourceKeys", "rooms"],
    ["resourceKeys", ["rooms", 1]],
    ["deferred", { analytics: true }],
    ["deferred", [null]],
    ["live", "rooms"],
    ["live", [null]],
    ["resourceErrors", []],
    ["resourceErrors", { activity: { type: "ResourceError" } }],
  ])("rejects malformed page envelope %s metadata", (field, value) => {
    expect(() => assertPageEnvelope({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {},
      [field]: value,
    })).toThrowError(ProtocolError);
  });

  it("rejects unknown mutation patch operations", () => {
    expect(() => assertMutationEnvelope({
      protocol: "fluxfast/1",
      mutation: { patches: { rooms: [{ op: "execute-code" }] } },
    })).toThrowError(MutationError);
    expect(() => assertMutationEnvelope({
      protocol: "fluxfast/1",
      mutation: { patches: { rooms: [{ op: "remove-item" }] } },
    })).toThrowError(/requires|Incomplete/);
  });

  it.each([
    [{ invalidate: [null] }, "array of strings"],
    [{ redirect: "https://example.com/rooms" }, "origin-relative"],
    [{ redirect: "//example.com/rooms" }, "origin-relative"],
    [{ redirect: "/\\example.com/rooms" }, "origin-relative"],
    [{ redirect: "/\n/example.com/rooms" }, "origin-relative"],
    [{ externalRedirect: "/login" }, "absolute HTTP(S)"],
    [{ externalRedirect: "javascript:alert(1)" }, "absolute HTTP(S)"],
    [{ patches: { rooms: [{ op: "merge-object", value: 1 }] } }, "Incomplete"],
    [{ patches: { rooms: [{ op: "remove-item", id: {} }] } }, "patch id"],
    [{ patches: { rooms: [{ op: "remove-item", match: [] }] } }, "patch match"],
  ])("rejects malformed mutation payload %#", (mutation, message) => {
    expect(() => assertMutationEnvelope({
      protocol: "fluxfast/1",
      mutation,
    })).toThrowError(message);
  });

  it("rejects an unsafe legacy external redirect header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        protocol: "fluxfast/1",
        mutation: {},
      }), {
        headers: {
          "content-type": "application/json",
          "X-FluxFast-External-Redirect": "javascript:alert(1)",
        },
      })
    ));

    await expect(new FetchTransport().mutate({ url: "/users", data: {} }))
      .rejects.toThrowError(/absolute HTTP\(S\)/);
  });

  it("maps standard FastAPI validation details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        detail: [{ loc: ["body", "email"], msg: "invalid email", type: "value_error" }],
      }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })
    ));

    await expect(new FetchTransport().mutate({ url: "/users", data: {} }))
      .rejects.toMatchObject<Partial<ValidationError>>({
        name: "ValidationError",
        details: { email: ["invalid email"] },
      });
  });
});
