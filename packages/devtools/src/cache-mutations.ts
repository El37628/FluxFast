import type { FluxDiagnosticEvent } from "@fluxfast/core";

export const MAX_CACHE_OBSERVATIONS = 100;
export const MAX_MUTATION_HISTORY = 100;
const MAX_TRACE_ROWS = 100;
const PATCH_OPERATIONS = new Set([
  "replace-resource",
  "merge-object",
  "replace-item",
  "remove-item",
  "append-item",
]);

export interface BrowserCacheObservation {
  readonly id: string;
  readonly timestamp: number;
  readonly action: "hit" | "miss" | "write";
  readonly source: string;
  readonly path: string;
  readonly correlationId: string | null;
}

export interface ServerCacheObservation {
  readonly key: string;
  readonly result: string;
  readonly cacheResult: "hit" | "miss" | "bypass";
  readonly backend: "memory" | "redis" | "custom";
  readonly durationMs: number;
  readonly cacheMs: number | null;
  readonly loaderMs: number | null;
  readonly knownVersion: boolean;
  readonly sent: boolean;
}

export interface ServerCacheRequest {
  readonly eventId: string;
  readonly timestamp: number;
  readonly correlationId: string | null;
  readonly path: string;
  readonly durationMs: number;
  readonly hitCount: number;
  readonly lookupCount: number;
  readonly redisActive: boolean;
  readonly knownVersionOmissions: number;
  readonly truncated: boolean;
  readonly resources: readonly ServerCacheObservation[];
}

export interface CacheInsights {
  readonly browser: {
    readonly hits: number;
    readonly misses: number;
    readonly writes: number;
    readonly observations: readonly BrowserCacheObservation[];
  };
  readonly server: ServerCacheRequest | null;
}

export interface MutationPatchOperation {
  readonly name: string;
  readonly count: number;
}

export interface MutationPatchInsight {
  readonly key: string;
  readonly operations: readonly MutationPatchOperation[];
}

export interface MutationInsight {
  readonly id: string;
  readonly correlationId: string | null;
  readonly timestamp: number;
  readonly method: string;
  readonly path: string;
  readonly result: "pending" | "success" | "error";
  readonly errorType: string | null;
  readonly durationMs: number | null;
  readonly handlerMs: number | null;
  readonly invalidationMs: number | null;
  readonly serializeMs: number | null;
  readonly patches: readonly MutationPatchInsight[];
  readonly invalidated: readonly string[];
  readonly invalidationCount: number;
  readonly liveSignals: number;
  readonly redirect: "none" | "internal" | "external";
  readonly truncated: boolean;
}

interface MutableMutation {
  id: string;
  correlationId: string | null;
  timestamp: number;
  updatedAt: number;
  method: string;
  path: string;
  result: "pending" | "success" | "error";
  errorType: string | null;
  durationMs: number | null;
  handlerMs: number | null;
  invalidationMs: number | null;
  serializeMs: number | null;
  patches: readonly MutationPatchInsight[];
  invalidated: readonly string[];
  invalidationCount: number;
  liveSignals: number;
  redirect: "none" | "internal" | "external";
  truncated: boolean;
  startedAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maximum = 2_048): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safePath(value: unknown): string | undefined {
  const candidate = safeText(value);
  if (!candidate) return undefined;
  try {
    return new URL(candidate, "http://fluxfast.local").pathname || "/";
  } catch {
    return candidate.split(/[?#]/, 1)[0] || "/";
  }
}

function safeCorrelation(event: FluxDiagnosticEvent): string | null {
  return safeText(event.correlationId, 128) ?? null;
}

function safeServerResource(value: unknown): ServerCacheObservation | undefined {
  if (!isRecord(value)) return undefined;
  const key = safeText(value.key, 128);
  const result = safeText(value.result, 64);
  const durationMs = safeNumber(value.durationMs);
  const cacheResult = value.cacheResult;
  const backend = value.cacheBackend;
  if (
    !key ||
    !result ||
    durationMs === undefined ||
    (cacheResult !== "hit" && cacheResult !== "miss" && cacheResult !== "bypass") ||
    (backend !== "memory" && backend !== "redis" && backend !== "custom")
  ) {
    return undefined;
  }
  return Object.freeze({
    key,
    result,
    cacheResult,
    backend,
    durationMs,
    cacheMs: safeNumber(value.cacheMs) ?? null,
    loaderMs: safeNumber(value.loaderMs) ?? null,
    knownVersion: value.knownVersion === true,
    sent: value.sent !== false,
  });
}

function browserCacheInsights(
  events: readonly FluxDiagnosticEvent[]
): CacheInsights["browser"] {
  const observations: BrowserCacheObservation[] = [];
  for (
    let index = events.length - 1;
    index >= 0 && observations.length < MAX_CACHE_OBSERVATIONS;
    index -= 1
  ) {
    const event = events[index];
    if (event.type !== "page-cache" || !isRecord(event.data)) continue;
    const action = event.data.action;
    const source = safeText(event.data.source, 128) ?? "page cache";
    const path = safePath(event.data.url) ?? "/";
    if (action !== "hit" && action !== "miss" && action !== "write") continue;
    observations.push(Object.freeze({
      id: event.id,
      timestamp: safeTimestamp(event.timestamp),
      action,
      source,
      path,
      correlationId: safeCorrelation(event),
    }));
  }
  return Object.freeze({
    hits: observations.filter(item => item.action === "hit").length,
    misses: observations.filter(item => item.action === "miss").length,
    writes: observations.filter(item => item.action === "write").length,
    observations: Object.freeze(observations),
  });
}

function correlatedPath(
  events: readonly FluxDiagnosticEvent[],
  correlationId: string | null
): string {
  if (correlationId === null) return "/";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (safeCorrelation(event) !== correlationId || !isRecord(event.data)) {
      continue;
    }
    const path = safePath(event.data.path) ?? safePath(event.data.url);
    if (path) return path;
  }
  return "/";
}

function latestServerCacheRequest(
  events: readonly FluxDiagnosticEvent[]
): ServerCacheRequest | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type !== "server-trace" ||
      !isRecord(event.data) ||
      event.data.type !== "page" ||
      !Array.isArray(event.data.resources)
    ) {
      continue;
    }
    const resources = event.data.resources
      .slice(0, MAX_TRACE_ROWS)
      .map(safeServerResource)
      .filter((item): item is ServerCacheObservation => item !== undefined);
    const correlationId = safeCorrelation(event);
    const lookupCount = resources.filter(
      item => item.cacheResult === "hit" || item.cacheResult === "miss"
    ).length;
    return Object.freeze({
      eventId: event.id,
      timestamp: safeTimestamp(event.timestamp),
      correlationId,
      path: correlatedPath(events, correlationId),
      durationMs: safeNumber(event.data.durationMs) ?? 0,
      hitCount: resources.filter(item => item.cacheResult === "hit").length,
      lookupCount,
      redisActive: resources.some(item => item.backend === "redis"),
      knownVersionOmissions: resources.filter(
        item => item.result === "omitted-known" || (item.knownVersion && !item.sent)
      ).length,
      truncated: event.data.truncated === true,
      resources: Object.freeze(resources),
    });
  }
  return null;
}

/** Derive browser and server cache observations without implying Redis access. */
export function deriveCacheInsights(
  events: readonly FluxDiagnosticEvent[]
): CacheInsights {
  return Object.freeze({
    browser: browserCacheInsights(events),
    server: latestServerCacheRequest(events),
  });
}

function safePatch(value: unknown): MutationPatchInsight | undefined {
  if (!isRecord(value) || !isRecord(value.operations)) return undefined;
  const key = safeText(value.key, 128);
  if (!key) return undefined;
  const operations = Object.entries(value.operations)
    .slice(0, 5)
    .flatMap(([name, count]) => {
      const safeCount = safeInteger(count);
      return PATCH_OPERATIONS.has(name) && safeCount !== undefined && safeCount > 0
        ? [Object.freeze({ name, count: safeCount })]
        : [];
    });
  return Object.freeze({ key, operations: Object.freeze(operations) });
}

function mutationIdentity(event: FluxDiagnosticEvent): string {
  return safeCorrelation(event) ?? `event:${event.id.slice(0, 128)}`;
}

function mutationFor(
  mutations: Map<string, MutableMutation>,
  event: FluxDiagnosticEvent
): MutableMutation {
  const identity = mutationIdentity(event);
  const existing = mutations.get(identity);
  if (existing) return existing;
  const timestamp = safeTimestamp(event.timestamp);
  const created: MutableMutation = {
    id: identity,
    correlationId: safeCorrelation(event),
    timestamp,
    updatedAt: timestamp,
    method: "POST",
    path: "/",
    result: "pending",
    errorType: null,
    durationMs: null,
    handlerMs: null,
    invalidationMs: null,
    serializeMs: null,
    patches: Object.freeze([]),
    invalidated: Object.freeze([]),
    invalidationCount: 0,
    liveSignals: 0,
    redirect: "none",
    truncated: false,
    startedAt: null,
  };
  mutations.set(identity, created);
  return created;
}

function observeMutationLifecycle(
  mutation: MutableMutation,
  event: FluxDiagnosticEvent,
  data: Record<string, unknown>
): void {
  mutation.method = safeText(data.method, 32) ?? mutation.method;
  mutation.path = safePath(data.url) ?? mutation.path;
  const phase = safeText(data.phase, 64);
  if (phase === "start") {
    mutation.startedAt = safeTimestamp(event.timestamp);
    mutation.timestamp = mutation.startedAt;
  } else if (phase === "success") {
    mutation.result = "success";
  } else if (phase === "error") {
    mutation.result = "error";
    mutation.errorType = safeText(data.errorType, 128) ?? "Error";
  }
}

function observeMutationTransport(
  mutation: MutableMutation,
  data: Record<string, unknown>
): void {
  mutation.method = safeText(data.method, 32) ?? mutation.method;
  mutation.path = safePath(data.path) ?? mutation.path;
  const durationMs = safeNumber(data.durationMs);
  if (durationMs !== undefined) mutation.durationMs = durationMs;
  if (data.phase === "success" && mutation.result !== "error") {
    mutation.result = "success";
  } else if (data.phase === "error") {
    mutation.result = "error";
    mutation.errorType = safeText(data.errorType, 128) ?? "Error";
  }
}

function observeMutationTrace(
  mutation: MutableMutation,
  data: Record<string, unknown>
): void {
  mutation.durationMs = safeNumber(data.durationMs) ?? mutation.durationMs;
  mutation.handlerMs = safeNumber(data.handlerMs) ?? null;
  mutation.invalidationMs = safeNumber(data.invalidationMs) ?? null;
  mutation.serializeMs = safeNumber(data.serializeMs) ?? null;
  mutation.patches = Object.freeze(
    (Array.isArray(data.patches) ? data.patches : [])
      .slice(0, MAX_TRACE_ROWS)
      .map(safePatch)
      .filter((item): item is MutationPatchInsight => item !== undefined)
  );
  mutation.invalidated = Object.freeze(
    (Array.isArray(data.invalidated) ? data.invalidated : [])
      .slice(0, MAX_TRACE_ROWS)
      .map(value => safeText(value, 128))
      .filter((item): item is string => item !== undefined)
  );
  mutation.invalidationCount = safeInteger(data.invalidationCount) ??
    mutation.invalidated.length;
  mutation.liveSignals = safeInteger(data.liveSignals) ?? 0;
  if (
    data.redirect === "none" ||
    data.redirect === "internal" ||
    data.redirect === "external"
  ) {
    mutation.redirect = data.redirect;
  }
  mutation.truncated = data.truncated === true;
}

/** Build a bounded, newest-first mutation history from correlation metadata. */
export function deriveMutationHistory(
  events: readonly FluxDiagnosticEvent[]
): readonly MutationInsight[] {
  const mutations = new Map<string, MutableMutation>();
  for (const event of events) {
    if (!isRecord(event.data)) continue;
    const data = event.data;
    const isLifecycle = event.type === "mutation";
    const isTransport = event.type === "transport" &&
      data.requestType === "mutation";
    const isServerTrace = event.type === "server-trace" &&
      data.type === "mutation";
    if (!isLifecycle && !isTransport && !isServerTrace) continue;

    const mutation = mutationFor(mutations, event);
    mutation.updatedAt = Math.max(
      mutation.updatedAt,
      safeTimestamp(event.timestamp)
    );
    if (isLifecycle) observeMutationLifecycle(mutation, event, data);
    if (isTransport) observeMutationTransport(mutation, data);
    if (isServerTrace) observeMutationTrace(mutation, data);
    if (
      mutation.durationMs === null &&
      mutation.startedAt !== null &&
      (mutation.result === "success" || mutation.result === "error")
    ) {
      mutation.durationMs = Math.max(0, mutation.updatedAt - mutation.startedAt);
    }
  }

  return Object.freeze(
    [...mutations.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_MUTATION_HISTORY)
      .map(mutation => Object.freeze({
        id: mutation.id,
        correlationId: mutation.correlationId,
        timestamp: mutation.timestamp,
        method: mutation.method,
        path: mutation.path,
        result: mutation.result,
        errorType: mutation.errorType,
        durationMs: mutation.durationMs,
        handlerMs: mutation.handlerMs,
        invalidationMs: mutation.invalidationMs,
        serializeMs: mutation.serializeMs,
        patches: mutation.patches,
        invalidated: mutation.invalidated,
        invalidationCount: mutation.invalidationCount,
        liveSignals: mutation.liveSignals,
        redirect: mutation.redirect,
        truncated: mutation.truncated,
      }))
  );
}

export function serverCacheResultLabel(
  observation: ServerCacheObservation
): string {
  if (observation.result === "omitted-known") return "KNOWN";
  if (observation.cacheResult === "hit") return "HIT";
  if (observation.cacheResult === "miss") return "MISS";
  if (observation.result === "loader") return "LOADER";
  return observation.result.replace(/-/g, " ").toLocaleUpperCase();
}

export function mutationResultLabel(mutation: MutationInsight): string {
  if (mutation.result !== "error") return mutation.result;
  return mutation.errorType === "ValidationError" ? "validation error" : "error";
}
