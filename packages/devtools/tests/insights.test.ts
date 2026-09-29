import { describe, expect, it } from "vitest";
import type { FluxDiagnosticEvent } from "@fluxfast/core";
import {
  deriveDevtoolsInsights,
  formatAge,
  formatDuration,
  formatTtl,
} from "../src/insights";
import type { DevtoolsSnapshot } from "../src/store";

function diagnostic(
  id: string,
  type: FluxDiagnosticEvent["type"],
  data: unknown
): FluxDiagnosticEvent {
  return { id, type, data, timestamp: 1_700_000_000_000 };
}

describe("deriveDevtoolsInsights", () => {
  it("combines value-free runtime metadata with the latest page trace", () => {
    const snapshot: DevtoolsSnapshot = {
      page: { component: "rooms/index", url: "/rooms" },
      clientId: "ff_client-1",
      selectedEventId: null,
      live: {
        status: "connected",
        connected: true,
        reconnectAttempt: 0,
        lastEventAt: 1_700_000_000_000,
      },
      liveResourceCount: 1,
      resources: [
        {
          key: "rooms",
          version: "rooms-v2",
          updatedAt: 1_700_000_000_000,
          status: "ready",
          stale: false,
          hasSubscribers: true,
        },
        {
          key: "profile",
          version: null,
          updatedAt: null,
          status: "pending",
          stale: false,
          hasSubscribers: false,
        },
      ],
      events: [
        diagnostic("trace-1", "server-trace", {
          type: "page",
          durationMs: 12.4,
          resources: [
            {
              key: "rooms",
              result: "cache-hit",
              durationMs: 2.2,
              scope: "tenant",
              ttl: 30_000,
              deferred: false,
              live: true,
              cacheBackend: "redis",
              cacheResult: "hit",
              cacheMs: 1.1,
              loaderMs: 0,
              value: "must-never-be-projected",
            },
            {
              key: "profile",
              result: "deferred",
              durationMs: 0.4,
              scope: "user",
              ttl: 5_000,
              deferred: true,
              live: false,
              cacheBackend: "memory",
              cacheResult: "miss",
            },
          ],
        }),
        diagnostic("update-1", "resource-update", {
          key: "rooms",
          version: "rooms-v2",
          source: "live-update",
        }),
      ],
    };

    const insights = deriveDevtoolsInsights(snapshot);

    expect(insights.overview).toEqual({
      latestRequestMs: 12.4,
      totalResources: 2,
      readyResources: 1,
      staleResources: 0,
      pendingResources: 1,
      errorResources: 0,
      cacheHits: 1,
      cacheMisses: 1,
      deferredResources: 1,
      liveResources: 1,
      errorCount: 0,
    });
    expect(insights.resources[0]).toEqual(expect.objectContaining({
      key: "rooms",
      source: "cache",
      serverResult: "cache-hit",
      cacheBackend: "redis",
      cacheResult: "hit",
      scope: "tenant",
      ttl: 30_000,
      live: true,
      lastUpdateReason: "live-update",
    }));
    expect(JSON.stringify(insights)).not.toContain("must-never-be-projected");
  });

  it("uses the newest page trace and safely ignores malformed trace rows", () => {
    const snapshot: DevtoolsSnapshot = {
      page: { component: "", url: "/" },
      clientId: "ff_client-1",
      selectedEventId: null,
      live: {
        status: "idle",
        connected: false,
        reconnectAttempt: 0,
        lastEventAt: null,
      },
      liveResourceCount: 0,
      resources: [],
      events: [
        diagnostic("trace-old", "server-trace", {
          type: "page",
          durationMs: 40,
          resources: [],
        }),
        diagnostic("trace-new", "server-trace", {
          type: "page",
          durationMs: 8,
          resources: [{ key: "unsafe", value: "secret" }],
        }),
      ],
    };

    const insights = deriveDevtoolsInsights(snapshot);
    expect(insights.overview.latestRequestMs).toBe(8);
    expect(insights.overview.cacheHits).toBe(0);
    expect(JSON.stringify(insights)).not.toContain("secret");
  });
});

describe("insight formatters", () => {
  it("formats durations, ages, and TTLs compactly", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0.25)).toBe("0.3 ms");
    expect(formatDuration(12.6)).toBe("13 ms");
    expect(formatAge(null)).toBe("—");
    expect(formatAge(1_000, 2_500)).toBe("now");
    expect(formatAge(1_000, 62_000)).toBe("1m");
    expect(formatTtl(500)).toBe("500 ms");
    expect(formatTtl(30_000)).toBe("30s");
  });
});
