import type { FluxDiagnosticEvent } from "@fluxfast/core";
import type { DevtoolsSnapshot } from "./store.js";

interface SafeResourceTrace {
  readonly key: string;
  readonly result: string;
  readonly durationMs: number;
  readonly scope: string;
  readonly ttl: number;
  readonly deferred: boolean;
  readonly live: boolean;
  readonly cacheBackend: string;
  readonly cacheResult: string;
  readonly cacheMs?: number;
  readonly loaderMs?: number;
  readonly errorType?: string;
}

export interface DevtoolsOverview {
  readonly latestRequestMs: number | null;
  readonly totalResources: number;
  readonly readyResources: number;
  readonly staleResources: number;
  readonly pendingResources: number;
  readonly errorResources: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly deferredResources: number;
  readonly liveResources: number;
  readonly errorCount: number;
}

export interface DevtoolsResourceInsight {
  readonly key: string;
  readonly version: string | null;
  readonly status: string;
  readonly stale: boolean;
  readonly updatedAt: number | null;
  readonly hasSubscribers: boolean;
  readonly source: string;
  readonly serverResult: string | null;
  readonly durationMs: number | null;
  readonly cacheBackend: string | null;
  readonly cacheResult: string | null;
  readonly cacheMs: number | null;
  readonly loaderMs: number | null;
  readonly scope: string | null;
  readonly ttl: number | null;
  readonly deferred: boolean;
  readonly live: boolean;
  readonly lastUpdateReason: string | null;
  readonly errorType: string | null;
}

export interface DevtoolsInsights {
  readonly overview: DevtoolsOverview;
  readonly resources: readonly DevtoolsResourceInsight[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, maximum = 2_048): string | undefined {
  return typeof value === "string" && value.length <= maximum
    ? value
    : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function safeTraceResource(value: unknown): SafeResourceTrace | undefined {
  if (!isRecord(value)) return undefined;
  const key = safeString(value.key);
  const result = safeString(value.result, 64);
  const durationMs = safeNumber(value.durationMs);
  const scope = safeString(value.scope, 64);
  const ttl = safeNumber(value.ttl);
  const cacheBackend = safeString(value.cacheBackend, 64);
  const cacheResult = safeString(value.cacheResult, 64);
  const cacheMs = safeNumber(value.cacheMs);
  const loaderMs = safeNumber(value.loaderMs);
  const errorType = safeString(value.errorType, 128);
  if (
    !key ||
    !result ||
    durationMs === undefined ||
    !scope ||
    ttl === undefined ||
    typeof value.deferred !== "boolean" ||
    typeof value.live !== "boolean" ||
    !cacheBackend ||
    !cacheResult
  ) {
    return undefined;
  }
  return {
    key,
    result,
    durationMs,
    scope,
    ttl,
    deferred: value.deferred,
    live: value.live,
    cacheBackend,
    cacheResult,
    ...(cacheMs === undefined ? {} : { cacheMs }),
    ...(loaderMs === undefined ? {} : { loaderMs }),
    ...(errorType === undefined ? {} : { errorType }),
  };
}

function serverTrace(
  event: FluxDiagnosticEvent
): Record<string, unknown> | undefined {
  return event.type === "server-trace" && isRecord(event.data)
    ? event.data
    : undefined;
}

function latestServerDuration(
  events: readonly FluxDiagnosticEvent[]
): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const trace = serverTrace(events[index]);
    const duration = trace ? safeNumber(trace.durationMs) : undefined;
    if (duration !== undefined) return duration;
  }
  return null;
}

function latestPageResources(
  events: readonly FluxDiagnosticEvent[]
): readonly SafeResourceTrace[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const trace = serverTrace(events[index]);
    if (!trace || trace.type !== "page" || !Array.isArray(trace.resources)) {
      continue;
    }
    return trace.resources
      .map(safeTraceResource)
      .filter(
        (resource): resource is SafeResourceTrace => resource !== undefined
      );
  }
  return [];
}

function lastUpdateReasons(
  events: readonly FluxDiagnosticEvent[]
): ReadonlyMap<string, string> {
  const reasons = new Map<string, string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type !== "resource-update" &&
      event.type !== "resource-invalidate"
    ) {
      continue;
    }
    if (!isRecord(event.data)) continue;
    const key = safeString(event.data.key);
    const source = safeString(event.data.source, 128);
    if (key && source && !reasons.has(key)) reasons.set(key, source);
  }
  return reasons;
}

function resourceSource(trace: SafeResourceTrace | undefined): string {
  if (!trace) return "runtime";
  if (trace.result === "cache-hit") return "cache";
  if (trace.result === "cache-miss") return "cache miss";
  if (trace.result === "omitted-known") return "known version";
  return trace.result;
}

function isErrorEvent(event: FluxDiagnosticEvent): boolean {
  if (!isRecord(event.data)) return false;
  return event.data.phase === "error" || event.data.state === "error";
}

/** Derive display-only, value-free views from the bounded runtime snapshot. */
export function deriveDevtoolsInsights(
  snapshot: DevtoolsSnapshot
): DevtoolsInsights {
  const pageResources = latestPageResources(snapshot.events);
  const traceByKey = new Map(
    pageResources.map(resource => [resource.key, resource])
  );
  const reasons = lastUpdateReasons(snapshot.events);
  const resources = snapshot.resources.map(resource => {
    const trace = traceByKey.get(resource.key);
    return Object.freeze({
      key: resource.key,
      version: resource.version,
      status: resource.status,
      stale: resource.stale,
      updatedAt: resource.updatedAt,
      hasSubscribers: resource.hasSubscribers,
      source: resourceSource(trace),
      serverResult: trace?.result ?? null,
      durationMs: trace?.durationMs ?? null,
      cacheBackend: trace?.cacheBackend ?? null,
      cacheResult: trace?.cacheResult ?? null,
      cacheMs: trace?.cacheMs ?? null,
      loaderMs: trace?.loaderMs ?? null,
      scope: trace?.scope ?? null,
      ttl: trace?.ttl ?? null,
      deferred: trace?.deferred ?? false,
      live: trace?.live ?? false,
      lastUpdateReason: reasons.get(resource.key) ?? null,
      errorType: trace?.errorType ?? null,
    });
  });
  const errorResources = snapshot.resources.filter(
    resource => resource.status === "error"
  ).length;
  const nonResourceErrors = snapshot.events.filter(
    event => event.type !== "resource-update" && isErrorEvent(event)
  ).length;

  return Object.freeze({
    overview: Object.freeze({
      latestRequestMs: latestServerDuration(snapshot.events),
      totalResources: snapshot.resources.length,
      readyResources: snapshot.resources.filter(
        resource => resource.status === "ready"
      ).length,
      staleResources: snapshot.resources.filter(resource => resource.stale)
        .length,
      pendingResources: snapshot.resources.filter(
        resource => resource.status === "pending" || resource.status === "loading"
      ).length,
      errorResources,
      cacheHits: pageResources.filter(resource => resource.cacheResult === "hit")
        .length,
      cacheMisses: pageResources.filter(resource => resource.cacheResult === "miss")
        .length,
      deferredResources: pageResources.filter(resource => resource.deferred)
        .length,
      liveResources: Math.max(
        snapshot.liveResourceCount,
        pageResources.filter(resource => resource.live).length
      ),
      errorCount: errorResources + nonResourceErrors,
    }),
    resources: Object.freeze(resources),
  });
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return `${value.toFixed(1)} ms`;
  return `${Math.round(value)} ms`;
}

export function formatAge(updatedAt: number | null, now = Date.now()): string {
  if (updatedAt === null) return "—";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (seconds < 2) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatTtl(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${value} ms`;
  return `${value / 1_000}s`;
}
