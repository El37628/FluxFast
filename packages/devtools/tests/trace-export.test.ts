import { describe, expect, it } from "vitest";
import type { DevtoolsSnapshot } from "../src/store";
import {
  createSafeTraceExport,
  DEVTOOLS_EXPORT_FORMAT,
} from "../src/trace-export";

describe("createSafeTraceExport", () => {
  it("copies bounded derived metadata without raw diagnostic fields", () => {
    const snapshot: DevtoolsSnapshot = {
      page: { component: "rooms/index", url: "/rooms" },
      clientId: "ff_client-private",
      selectedEventId: null,
      live: {
        status: "connected",
        connected: true,
        reconnectAttempt: 0,
        lastEventAt: 1_700_000_000_000,
      },
      liveResourceCount: 1,
      resources: [{
        key: "rooms",
        version: "rooms-v1",
        updatedAt: 1_700_000_000_000,
        status: "ready",
        stale: false,
        hasSubscribers: true,
      }],
      events: [
        {
          id: "transport-start",
          type: "transport",
          timestamp: 1_700_000_000_000,
          correlationId: "visit-1",
          data: {
            phase: "start",
            requestType: "page",
            method: "GET",
            path: "/rooms?token=query-secret",
            protocol: "fluxfast/1",
            capabilities: ["deferred-resources"],
            knownVersions: [{ key: "rooms", version: "rooms-v1" }],
            only: [],
            headers: { Authorization: "Bearer header-secret" },
          },
        },
        {
          id: "server-trace",
          type: "server-trace",
          timestamp: 1_700_000_000_010,
          correlationId: "visit-1",
          data: {
            protocol: "fluxfast-devtools/1",
            type: "page",
            durationMs: 10,
            truncated: false,
            resources: [{
              key: "rooms",
              result: "cache-hit",
              durationMs: 1,
              scope: "tenant",
              ttl: 30_000,
              deferred: false,
              live: true,
              cacheBackend: "redis",
              cacheResult: "hit",
              sent: true,
              knownVersion: false,
              value: "resource-secret",
            }],
          },
        },
        {
          id: "transport-finish",
          type: "transport",
          timestamp: 1_700_000_000_012,
          correlationId: "visit-1",
          data: {
            phase: "success",
            requestType: "page",
            method: "GET",
            path: "/rooms",
            durationMs: 12,
            serverTrace: "valid",
          },
        },
      ],
    };

    const serialized = createSafeTraceExport(snapshot, 1_700_000_000_100);
    const trace = JSON.parse(serialized);

    expect(trace).toMatchObject({
      format: DEVTOOLS_EXPORT_FORMAT,
      page: { component: "rooms/index", url: "/rooms" },
      overview: { totalResources: 1, cacheHits: 1 },
      protocol: {
        path: "/rooms",
        knownVersions: [{ key: "rooms", version: "rooms-v1" }],
      },
    });
    expect(trace.timeline.length).toBeGreaterThan(0);
    expect(serialized).not.toMatch(/query-secret|header-secret|resource-secret|Authorization|Bearer|ff_client-private/);
  });
});
