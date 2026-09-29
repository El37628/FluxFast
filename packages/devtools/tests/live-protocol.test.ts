import { describe, expect, it } from "vitest";
import type { FluxDiagnosticEvent } from "@fluxfast/core";
import {
  abbreviatedVersion,
  deriveLiveInsights,
  deriveProtocolRequest,
  MAX_LIVE_OBSERVATIONS,
} from "../src/live-protocol";

function diagnostic(
  id: string,
  type: FluxDiagnosticEvent["type"],
  data: unknown,
  timestamp: number,
  correlationId?: string
): FluxDiagnosticEvent {
  return {
    id,
    type,
    data,
    timestamp,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

describe("deriveLiveInsights", () => {
  it("summarizes existing live and canonical-refresh observations", () => {
    const events: FluxDiagnosticEvent[] = [
      diagnostic("connecting", "live", {
        phase: "connect:start",
        keyCount: 2,
        reconnectAttempt: 0,
      }, 1),
      diagnostic("connected", "live", {
        phase: "connect:open",
        keyCount: 2,
        reconnectAttempt: 0,
      }, 2),
      diagnostic("invalidate", "live", {
        phase: "event",
        eventType: "invalidate",
        keyCount: 1,
      }, 3, "live-1"),
      diagnostic("refresh-start", "resource-load", {
        phase: "start",
        reason: "live",
        keyCount: 1,
      }, 4, "live-1"),
      diagnostic("refresh-success", "resource-load", {
        phase: "success",
        reason: "live",
        keyCount: 1,
      }, 5, "live-1"),
      diagnostic("reconnect", "live", {
        phase: "reconnect",
        keyCount: 2,
        reconnectAttempt: 1,
      }, 6),
      diagnostic("resync", "live", {
        phase: "event",
        eventType: "resync",
        reason: "reconnect",
        keyCount: 2,
      }, 7, "live-2"),
      diagnostic("overflow", "live", {
        phase: "event",
        eventType: "resync",
        reason: "overflow",
        keyCount: 2,
        value: "must-not-be-read",
      }, 8, "live-3"),
    ];

    const insights = deriveLiveInsights(events);

    expect(insights).toMatchObject({
      reconnectCount: 1,
      resyncCount: 2,
      queueOverflowCount: 1,
    });
    expect(insights.lastEvent).toMatchObject({
      label: "RESYNC",
      detail: "overflow",
      keyCount: 2,
    });
    expect(insights.observations.map(item => item.label)).toEqual([
      "CONNECTING",
      "CONNECTED",
      "INVALIDATE",
      "CANONICAL REFRESH",
      "CANONICAL REFRESH",
      "RECONNECT",
      "RESYNC",
      "RESYNC",
    ]);
    expect(JSON.stringify(insights)).not.toContain("must-not-be-read");
  });

  it("bounds the rendered live history independently", () => {
    const events = Array.from({ length: 120 }, (_, index) => diagnostic(
      `live-${index}`,
      "live",
      { phase: "event", eventType: "patch", keyCount: 1 },
      index
    ));
    const insights = deriveLiveInsights(events);
    expect(insights.observations).toHaveLength(MAX_LIVE_OBSERVATIONS);
    expect(insights.observations[0].id).toBe("live-20");
    expect(insights.lastEvent?.id).toBe("live-119");
  });
});

describe("deriveProtocolRequest", () => {
  it("renders only known FluxFast request and response metadata", () => {
    const events: FluxDiagnosticEvent[] = [
      diagnostic("start", "transport", {
        phase: "start",
        requestType: "page",
        method: "GET",
        path: "/rooms?request-secret=one",
        protocol: "fluxfast/1",
        capabilities: ["deferred-resources", "live-resources"],
        knownVersions: [
          { key: "auth", version: "91ac1234567890" },
          { key: "rooms", version: "c8219876543210" },
        ],
        only: ["rooms"],
        headers: { Authorization: "Bearer secret" },
      }, 1_000, "visit-1"),
      diagnostic("trace", "server-trace", {
        protocol: "fluxfast-devtools/1",
        type: "page",
        durationMs: 12,
        truncated: false,
        resources: [
          {
            key: "auth",
            result: "omitted-known",
            sent: false,
            knownVersion: true,
            deferred: false,
            value: "resource-secret-two",
          },
          {
            key: "rooms",
            result: "loader",
            sent: true,
            knownVersion: false,
            deferred: false,
          },
          {
            key: "analytics",
            result: "deferred",
            sent: false,
            knownVersion: false,
            deferred: true,
          },
          {
            key: "broken",
            result: "error",
            sent: false,
            knownVersion: false,
            deferred: false,
          },
        ],
      }, 1_010, "visit-1"),
      diagnostic("finish", "transport", {
        phase: "success",
        requestType: "page",
        method: "GET",
        path: "/rooms",
        status: 200,
        durationMs: 18,
        serverTrace: "valid",
      }, 1_018, "visit-1"),
    ];

    const request = deriveProtocolRequest(events);

    expect(request).toMatchObject({
      correlationId: "visit-1",
      requestType: "page",
      method: "GET",
      path: "/rooms",
      status: "success",
      httpStatus: 200,
      durationMs: 18,
      protocol: "fluxfast/1",
      diagnosticProtocol: "fluxfast-devtools/1",
      capabilities: ["deferred-resources", "live-resources"],
      knownVersions: [
        { key: "auth", version: "91ac1234567890" },
        { key: "rooms", version: "c8219876543210" },
      ],
      only: ["rooms"],
      serverTrace: "valid",
      response: {
        resourceObservations: 4,
        resourcesSent: 1,
        resourcesOmitted: 1,
        deferred: 1,
        errors: 1,
        patchResources: 0,
        invalidations: 0,
        liveSignals: 0,
      },
    });
    expect(JSON.stringify(request)).not.toMatch(/Authorization|Bearer|secret|value/);
    expect(abbreviatedVersion("12345678901234567890")).toBe("12345678901…");
  });

  it("surfaces unsupported diagnostic versions without inventing a trace", () => {
    const request = deriveProtocolRequest([
      diagnostic("start", "transport", {
        phase: "start",
        requestType: "page",
        method: "GET",
        path: "/",
        protocol: "fluxfast/1",
      }, 1, "visit-2"),
      diagnostic("finish", "transport", {
        phase: "success",
        requestType: "page",
        serverTrace: "unsupported",
        serverTraceProtocol: "fluxfast-devtools/2",
      }, 2, "visit-2"),
    ]);

    expect(request).toMatchObject({
      serverTrace: "unsupported",
      diagnosticProtocol: "fluxfast-devtools/2",
      status: "success",
    });
  });

  it("supports an initial SSR trace without browser transport events", () => {
    const request = deriveProtocolRequest([
      diagnostic("ssr", "server-trace", {
        protocol: "fluxfast-devtools/1",
        type: "page",
        path: "/dashboard?secret=hidden",
        source: "ssr",
        durationMs: 9,
        resources: [],
        truncated: false,
      }, 100, "ffdev-ssr"),
    ]);

    expect(request).toMatchObject({
      path: "/dashboard",
      source: "ssr",
      status: "success",
      protocol: "fluxfast/1",
      diagnosticProtocol: "fluxfast-devtools/1",
      serverTrace: "valid",
    });
  });
});
