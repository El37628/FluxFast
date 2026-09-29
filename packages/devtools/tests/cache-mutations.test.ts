import { describe, expect, it } from "vitest";
import type { FluxDiagnosticEvent } from "@fluxfast/core";
import {
  deriveCacheInsights,
  deriveMutationHistory,
  MAX_CACHE_OBSERVATIONS,
  MAX_MUTATION_HISTORY,
  mutationResultLabel,
  serverCacheResultLabel,
} from "../src/cache-mutations";

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

describe("deriveCacheInsights", () => {
  it("keeps browser page caching separate from server resource caching", () => {
    const events: FluxDiagnosticEvent[] = [
      diagnostic("browser-miss", "page-cache", {
        action: "miss",
        source: "navigation",
        url: "/rooms?browser-secret=one",
      }, 1_000, "visit-1"),
      diagnostic("transport-start", "transport", {
        phase: "start",
        requestType: "page",
        method: "GET",
        path: "/rooms?transport-secret=two",
      }, 1_001, "visit-1"),
      diagnostic("server", "server-trace", {
        type: "page",
        durationMs: 124,
        truncated: false,
        resources: [
          {
            key: "auth",
            result: "cache-hit",
            cacheResult: "hit",
            cacheBackend: "memory",
            durationMs: 0.3,
            cacheMs: 0.2,
            loaderMs: 0,
            knownVersion: false,
            sent: true,
            value: "resource-secret-three",
          },
          {
            key: "rooms",
            result: "cache-miss",
            cacheResult: "miss",
            cacheBackend: "redis",
            durationMs: 2.4,
            knownVersion: false,
            sent: true,
          },
          {
            key: "stats",
            result: "omitted-known",
            cacheResult: "bypass",
            cacheBackend: "redis",
            durationMs: 0.1,
            knownVersion: true,
            sent: false,
          },
          { key: "unsafe", value: "malformed-secret-four" },
        ],
      }, 1_002, "visit-1"),
      diagnostic("browser-write", "page-cache", {
        action: "write",
        url: "/rooms?write-secret=five",
      }, 1_003, "visit-1"),
    ];

    const insights = deriveCacheInsights(events);

    expect(insights.browser).toMatchObject({ hits: 0, misses: 1, writes: 1 });
    expect(insights.browser.observations.map(item => item.action)).toEqual([
      "write",
      "miss",
    ]);
    expect(insights.browser.observations.map(item => item.path)).toEqual([
      "/rooms",
      "/rooms",
    ]);
    expect(insights.server).toMatchObject({
      path: "/rooms",
      durationMs: 124,
      hitCount: 1,
      lookupCount: 2,
      redisActive: true,
      knownVersionOmissions: 1,
      truncated: false,
    });
    expect(insights.server?.resources).toHaveLength(3);
    expect(serverCacheResultLabel(insights.server!.resources[0])).toBe("HIT");
    expect(serverCacheResultLabel(insights.server!.resources[2])).toBe("KNOWN");
    expect(JSON.stringify(insights)).not.toMatch(/secret|value/);
  });

  it("bounds browser history independently and uses only the latest page trace", () => {
    const events: FluxDiagnosticEvent[] = [
      diagnostic("old-trace", "server-trace", {
        type: "page",
        durationMs: 90,
        resources: [],
      }, 1),
      ...Array.from({ length: 120 }, (_, index) => diagnostic(
        `cache-${index}`,
        "page-cache",
        { action: index % 2 === 0 ? "hit" : "miss", url: `/page-${index}` },
        index + 2
      )),
      diagnostic("new-trace", "server-trace", {
        type: "page",
        durationMs: 4,
        resources: [],
      }, 200),
    ];

    const insights = deriveCacheInsights(events);
    expect(insights.browser.observations).toHaveLength(MAX_CACHE_OBSERVATIONS);
    expect(insights.browser.observations[0].path).toBe("/page-119");
    expect(insights.server?.durationMs).toBe(4);
  });
});

describe("deriveMutationHistory", () => {
  it("correlates mutation results, safe patch counts, and invalidations", () => {
    const events: FluxDiagnosticEvent[] = [
      diagnostic("mutation-start", "mutation", {
        phase: "start",
        method: "PATCH",
        url: "/rooms/12?token=request-secret",
        body: { password: "body-secret" },
      }, 1_000, "mutation-1"),
      diagnostic("transport-start", "transport", {
        phase: "start",
        requestType: "mutation",
        method: "PATCH",
        path: "/rooms/12?token=transport-secret",
      }, 1_001, "mutation-1"),
      diagnostic("server-trace", "server-trace", {
        type: "mutation",
        durationMs: 42,
        handlerMs: 35,
        invalidationMs: 4,
        serializeMs: 3,
        patches: [{
          key: "rooms",
          operations: { "merge-object": 1, "execute-code": 99 },
          value: "patch-secret",
        }],
        invalidated: ["roomStats", "availability"],
        invalidationCount: 2,
        liveSignals: 2,
        redirect: "none",
        truncated: false,
        body: "trace-secret",
      }, 1_020, "mutation-1"),
      diagnostic("transport-success", "transport", {
        phase: "success",
        requestType: "mutation",
        method: "PATCH",
        path: "/rooms/12",
        durationMs: 48,
      }, 1_048, "mutation-1"),
      diagnostic("mutation-success", "mutation", {
        phase: "success",
        method: "PATCH",
        url: "/rooms/12",
      }, 1_050, "mutation-1"),
      diagnostic("validation-start", "mutation", {
        phase: "start",
        method: "POST",
        url: "/reservation",
      }, 2_000, "mutation-2"),
      diagnostic("validation-error", "mutation", {
        phase: "error",
        method: "POST",
        url: "/reservation",
        errorType: "ValidationError",
        detail: "validation-secret",
      }, 2_093, "mutation-2"),
    ];

    const history = deriveMutationHistory(events);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      method: "POST",
      path: "/reservation",
      result: "error",
      errorType: "ValidationError",
      durationMs: 93,
    });
    expect(mutationResultLabel(history[0])).toBe("validation error");
    expect(history[1]).toMatchObject({
      correlationId: "mutation-1",
      method: "PATCH",
      path: "/rooms/12",
      result: "success",
      durationMs: 48,
      handlerMs: 35,
      invalidationMs: 4,
      serializeMs: 3,
      invalidated: ["roomStats", "availability"],
      invalidationCount: 2,
      liveSignals: 2,
      redirect: "none",
    });
    expect(history[1].patches).toEqual([{
      key: "rooms",
      operations: [{ name: "merge-object", count: 1 }],
    }]);
    expect(JSON.stringify(history)).not.toMatch(/secret|password|body|value/);
  });

  it("bounds mutation history newest-first", () => {
    const events = Array.from({ length: 120 }, (_, index) => diagnostic(
      `mutation-${index}`,
      "mutation",
      { phase: "success", method: "DELETE", url: `/rooms/${index}` },
      index,
      `correlation-${index}`
    ));

    const history = deriveMutationHistory(events);
    expect(history).toHaveLength(MAX_MUTATION_HISTORY);
    expect(history[0].path).toBe("/rooms/119");
    expect(history.at(-1)?.path).toBe("/rooms/20");
  });
});
