import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeServerDiagnosticTrace,
  FetchTransport,
  FluxDiagnosticsHub,
  MAX_DEVTOOLS_TRACE_HEADER_CHARS,
  type FluxDiagnosticEvent,
} from "../src";
import {
  diagnosticErrorType,
  diagnosticText,
} from "../src/diagnostic-safety";

const TRACE_HEADER = "X-FluxFast-DevTools-Trace";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function pageTrace(resources: unknown[] = []): Record<string, unknown> {
  return {
    protocol: "fluxfast-devtools/1",
    requestId: "ffdev_0123456789abcdef",
    type: "page",
    durationMs: 4,
    pageMs: 1,
    resourcesMs: 2,
    serializeMs: 1,
    resources,
    truncated: false,
  };
}

function resource(key: string): Record<string, unknown> {
  return {
    key,
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
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("DevTools diagnostic security", () => {
  it("bounds text and collapses throwable-controlled names to safe categories", () => {
    expect(diagnosticText("rooms\r\nX-Injected: true", 128))
      .toBe("roomsX-Injected: true");
    expect(diagnosticText("x".repeat(140), 8)).toBe("xxxxxxx…");
    expect(diagnosticErrorType(Object.assign(new Error("private"), {
      name: "NetworkError",
    }))).toBe("NetworkError");
    expect(diagnosticErrorType(Object.assign(new Error("private"), {
      name: "Bearer private-token",
    }))).toBe("UnknownError");
  });

  it("treats HTML and prototype-sensitive resource keys as inert data", () => {
    delete (Object.prototype as { fluxfastPolluted?: boolean }).fluxfastPolluted;
    const keys = [
      "<script>globalThis.fluxfastPolluted=true</script>",
      "__proto__",
      "constructor",
      "prototype",
    ];

    const trace = decodeServerDiagnosticTrace(encode(pageTrace(
      keys.map(resource)
    )));

    expect((trace?.resources as Array<{ key: string }>).map(item => item.key))
      .toEqual(keys);
    expect(Object.prototype).not.toHaveProperty("fluxfastPolluted");
  });

  it.each([
    ["empty", ""],
    ["invalid alphabet", "not+base64"],
    ["invalid length", "A"],
    ["invalid UTF-8", Buffer.from([0xff]).toString("base64url")],
    ["invalid JSON", Buffer.from("{").toString("base64url")],
    ["oversized", "A".repeat(MAX_DEVTOOLS_TRACE_HEADER_CHARS + 1)],
    ["unknown protocol", encode({
      ...pageTrace(),
      protocol: "fluxfast-devtools/2",
    })],
    ["sensitive extra field", encode({
      ...pageTrace(),
      authorization: "Bearer must-not-survive",
    })],
    ["control-character key", encode(pageTrace([resource("rooms\r\nX-Evil: 1")]))],
    ["prototype operation", encode({
      protocol: "fluxfast-devtools/1",
      requestId: "ffdev_0123456789abcdef",
      type: "mutation",
      durationMs: 4,
      handlerMs: 1,
      invalidationMs: 1,
      serializeMs: 1,
      patches: [{
        key: "rooms",
        operations: JSON.parse('{"__proto__":1}'),
      }],
      invalidated: [],
      invalidationCount: 0,
      liveSignals: 0,
      redirect: "none",
      truncated: false,
    })],
  ])("fails closed for a %s trace", (_label, encoded) => {
    expect(decodeServerDiagnosticTrace(encoded)).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("fluxfastPolluted");
  });

  it("keeps hostile transport metadata out of diagnostics without changing the failure", async () => {
    const failure = Object.assign(new Error("request body contained a secret"), {
      name: "<img src=x onerror=globalThis.fluxfastPolluted=true>",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const hub = new FluxDiagnosticsHub();
    const events: FluxDiagnosticEvent[] = [];
    hub.subscribe(event => events.push(event));
    const transport = new FetchTransport();
    transport.attachDiagnostics(hub);

    await expect(transport.visit({
      url: "/rooms?authorization=Bearer-secret",
      visitId: "<script>secret()</script>",
    })).rejects.toBe(failure);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/Bearer-secret|request body contained|<script>|<img/);
    expect(events).toHaveLength(2);
    expect(events[0].correlationId).toMatch(/^transport_/);
    expect(events[1].data).toMatchObject({
      phase: "error",
      path: "/rooms",
      errorType: "UnknownError",
    });
  });

  it("ignores a malicious response trace while preserving the page envelope", async () => {
    const malicious = encode(JSON.parse(
      JSON.stringify(pageTrace()).replace(
        /}$/,
        ',"cookie":"session=must-not-survive","__proto__":{"fluxfastPolluted":true}}'
      )
    ));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: "fluxfast/1",
      page: { component: "rooms/index", url: "/rooms" },
      resources: {},
    }), {
      headers: {
        "content-type": "application/json",
        [TRACE_HEADER]: malicious,
      },
    })));
    const hub = new FluxDiagnosticsHub();
    const events: FluxDiagnosticEvent[] = [];
    hub.subscribe(event => events.push(event));
    const transport = new FetchTransport();
    transport.attachDiagnostics(hub);

    await expect(transport.visit({ url: "/rooms", visitId: "visit_safe" }))
      .resolves.toMatchObject({ page: { url: "/rooms" } });

    expect(events.filter(event => event.type === "server-trace")).toEqual([]);
    expect(events.at(-1)?.data).toMatchObject({ serverTrace: "invalid" });
    expect(JSON.stringify(events)).not.toContain("must-not-survive");
    expect(Object.prototype).not.toHaveProperty("fluxfastPolluted");
  });
});
