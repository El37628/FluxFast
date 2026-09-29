import { describe, expect, it } from "vitest";
import type { FluxDiagnosticEvent } from "@fluxfast/core";
import {
  deriveTimeline,
  filterTimeline,
  formatTimelineTime,
  MAX_TIMELINE_ITEMS,
} from "../src/timeline";

function event(
  id: string,
  type: FluxDiagnosticEvent["type"],
  data: unknown,
  timestamp: number,
  correlationId = "visit-1"
): FluxDiagnosticEvent {
  return { id, type, data, timestamp, correlationId };
}

describe("deriveTimeline", () => {
  it("builds correlated request, resource, and waterfall observations", () => {
    const items = deriveTimeline([
      event("navigation-start", "navigation", {
        phase: "start",
        url: "/rooms?token=must-not-leak",
      }, 1_700_000_000_000),
      event("cache-miss", "page-cache", {
        action: "miss",
        source: "navigation",
        url: "/rooms",
      }, 1_700_000_000_001),
      event("request", "transport", {
        phase: "start",
        requestType: "page",
        method: "GET",
        path: "/rooms",
      }, 1_700_000_000_002),
      event("trace", "server-trace", {
        type: "page",
        durationMs: 14,
        pageMs: 2,
        resourcesMs: 10,
        serializeMs: 2,
        resources: [
          {
            key: "rooms",
            result: "cache-hit",
            durationMs: 3,
            scope: "tenant",
            cacheBackend: "redis",
            cacheResult: "hit",
            deferred: false,
            value: "must-not-be-projected",
          },
          {
            key: "analytics",
            result: "deferred",
            durationMs: 0.5,
            scope: "user",
            cacheBackend: "memory",
            cacheResult: "miss",
            deferred: true,
          },
        ],
      }, 1_700_000_000_014),
      event("response", "transport", {
        phase: "success",
        requestType: "page",
        method: "GET",
        path: "/rooms",
        status: 200,
        durationMs: 16,
      }, 1_700_000_000_016),
    ]);

    expect(items.map(item => item.label)).toEqual([
      "NAVIGATION",
      "PAGE CACHE",
      "REQUEST",
      "SERVER",
      "RESOURCE rooms",
      "RESOURCE analytics",
      "RESPONSE",
    ]);
    expect(items.every(item => item.correlationId === "visit-1")).toBe(true);
    expect(items.find(item => item.label === "SERVER")?.waterfall).toEqual([
      { label: "Page handler", durationMs: 2, offsetMs: 0 },
      { label: "rooms", durationMs: 3, offsetMs: 2 },
      { label: "analytics", durationMs: 0.5, offsetMs: 2 },
      { label: "Serialize", durationMs: 2, offsetMs: 12 },
    ]);
    expect(JSON.stringify(items)).not.toContain("must-not-leak");
    expect(JSON.stringify(items)).not.toContain("must-not-be-projected");
  });

  it("supports category combinations, errors, and bounded text search", () => {
    const items = deriveTimeline([
      event("resource", "resource-update", {
        key: "rooms",
        source: "live",
      }, 1),
      event("mutation-error", "mutation", {
        phase: "error",
        method: "PATCH",
        url: "/rooms/12",
        errorType: "ResourceError",
      }, 2, "mutation-1"),
    ]);

    expect(filterTimeline(items, ["live"], "rooms")).toHaveLength(1);
    expect(filterTimeline(items, ["resource"], "ROOMS")).toHaveLength(1);
    expect(filterTimeline(items, ["error"], "patch")).toHaveLength(1);
    expect(filterTimeline(items, ["cache"], "")).toHaveLength(0);
  });

  it("expands correlated mutation patches, invalidations, and live signals", () => {
    const items = deriveTimeline([
      event("mutation-trace", "server-trace", {
        type: "mutation",
        durationMs: 7,
        handlerMs: 3,
        invalidationMs: 2,
        serializeMs: 2,
        patches: [
          { key: "rooms", operations: { "merge-object": 2 } },
        ],
        invalidated: ["availability"],
        liveSignals: 1,
      }, 1, "mutation-1"),
    ]);

    expect(items.map(item => item.label)).toEqual([
      "SERVER",
      "PATCH rooms",
      "INVALIDATE availability",
      "LIVE SIGNAL",
    ]);
    expect(items.every(item => item.correlationId === "mutation-1")).toBe(true);
    expect(filterTimeline(items, ["live"], "")).toHaveLength(1);
    expect(filterTimeline(items, ["resource"], "")).toHaveLength(2);
  });

  it("keeps expanded display rows within their independent hard bound", () => {
    const events = Array.from(
      { length: MAX_TIMELINE_ITEMS + 100 },
      (_, index) => event(
        `event-${index}`,
        "navigation",
        { phase: "success", url: `/page-${index}` },
        index,
        `visit-${index}`
      )
    );

    const items = deriveTimeline(events);
    expect(items).toHaveLength(MAX_TIMELINE_ITEMS);
    expect(items[0].sourceEventId).toBe("event-100");
    expect(items.at(-1)?.sourceEventId).toBe(`event-${MAX_TIMELINE_ITEMS + 99}`);
  });
});

describe("formatTimelineTime", () => {
  it("includes milliseconds", () => {
    expect(formatTimelineTime(1_700_000_000_123)).toMatch(
      /^\d{2}:\d{2}:\d{2}\.123$/
    );
  });
});
