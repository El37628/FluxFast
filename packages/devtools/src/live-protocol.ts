import type { FluxDiagnosticEvent } from "@fluxfast/core";

export const MAX_LIVE_OBSERVATIONS = 100;
const MAX_PROTOCOL_ITEMS = 100;

export interface LiveObservation {
  readonly id: string;
  readonly timestamp: number;
  readonly label: string;
  readonly detail: string;
  readonly keyCount: number | null;
  readonly reconnectAttempt: number | null;
  readonly correlationId: string | null;
  readonly error: boolean;
}

export interface LiveInsights {
  readonly reconnectCount: number;
  readonly resyncCount: number;
  readonly queueOverflowCount: number;
  readonly lastEvent: LiveObservation | null;
  readonly observations: readonly LiveObservation[];
}

export interface ProtocolKnownVersion {
  readonly key: string;
  readonly version: string;
}

export interface ProtocolResponseSummary {
  readonly resourceObservations: number;
  readonly resourcesSent: number;
  readonly resourcesOmitted: number;
  readonly deferred: number;
  readonly errors: number;
  readonly patchResources: number;
  readonly invalidations: number;
  readonly liveSignals: number;
}

export interface ProtocolRequestInsight {
  readonly id: string;
  readonly correlationId: string | null;
  readonly timestamp: number;
  readonly requestType: "page" | "mutation";
  readonly method: string;
  readonly path: string;
  readonly status: "pending" | "success" | "error";
  readonly httpStatus: number | null;
  readonly durationMs: number | null;
  readonly protocol: string | null;
  readonly diagnosticProtocol: string | null;
  readonly capabilities: readonly string[];
  readonly knownVersions: readonly ProtocolKnownVersion[];
  readonly only: readonly string[];
  readonly serverTrace: "pending" | "missing" | "valid" | "invalid" | "unsupported";
  readonly response: ProtocolResponseSummary;
  readonly truncated: boolean;
  readonly source: "browser" | "ssr";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 2_048): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function timestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function path(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    return new URL(candidate, "http://fluxfast.local").pathname || "/";
  } catch {
    return candidate.split(/[?#]/, 1)[0] || "/";
  }
}

function correlation(event: FluxDiagnosticEvent): string | null {
  return text(event.correlationId, 128) ?? null;
}

function liveObservation(event: FluxDiagnosticEvent): LiveObservation | null {
  if (!isRecord(event.data)) return null;
  const data = event.data;
  if (event.type === "resource-load") {
    const reason = text(data.reason, 64);
    if (reason !== "live" && reason !== "live-reconnect") return null;
    const phase = text(data.phase, 64) ?? "refresh";
    return Object.freeze({
      id: event.id,
      timestamp: timestamp(event.timestamp),
      label: "CANONICAL REFRESH",
      detail: `${reason === "live-reconnect" ? "resync" : "live"} · ${phase}`,
      keyCount: integer(data.keyCount) ?? null,
      reconnectAttempt: null,
      correlationId: correlation(event),
      error: phase === "error",
    });
  }
  if (event.type !== "live") return null;

  const phase = text(data.phase, 64) ?? "event";
  const eventType = text(data.eventType, 64);
  const reason = text(data.reason, 128);
  let label = phase.toLocaleUpperCase();
  if (phase === "connect:start") label = "CONNECTING";
  if (phase === "connect:open") label = "CONNECTED";
  if (phase === "connect:close") label = reason === "offline" ? "OFFLINE" : "DISCONNECTED";
  if (phase === "connect:error") label = "CONNECTION ERROR";
  if (phase === "reconnect") label = "RECONNECT";
  if (phase === "event" && eventType) label = eventType.toLocaleUpperCase();
  const detail = [
    reason,
    data.selfOriginated === true ? "self-originated" : undefined,
    data.willReconnect === true ? "will reconnect" : undefined,
  ].filter((item): item is string => item !== undefined).join(" · ");
  return Object.freeze({
    id: event.id,
    timestamp: timestamp(event.timestamp),
    label,
    detail,
    keyCount: integer(data.keyCount) ?? null,
    reconnectAttempt: integer(data.reconnectAttempt) ?? null,
    correlationId: correlation(event),
    error: phase === "connect:error" || text(data.errorType, 128) !== undefined,
  });
}

/** Summarize existing LiveManager observations without creating live state. */
export function deriveLiveInsights(
  events: readonly FluxDiagnosticEvent[]
): LiveInsights {
  let reconnectCount = 0;
  let resyncCount = 0;
  let queueOverflowCount = 0;
  let lastEvent: LiveObservation | null = null;
  const observations: LiveObservation[] = [];

  for (const event of events) {
    if (event.type === "live" && isRecord(event.data)) {
      if (event.data.phase === "reconnect") reconnectCount += 1;
      if (event.data.phase === "event" && event.data.eventType === "resync") {
        resyncCount += 1;
        if (event.data.reason === "overflow") queueOverflowCount += 1;
      }
    }
    const observation = liveObservation(event);
    if (!observation) continue;
    if (
      event.type === "live" &&
      isRecord(event.data) &&
      event.data.phase === "event"
    ) {
      lastEvent = observation;
    }
    observations.push(observation);
  }

  return Object.freeze({
    reconnectCount,
    resyncCount,
    queueOverflowCount,
    lastEvent,
    observations: Object.freeze(observations.slice(-MAX_LIVE_OBSERVATIONS)),
  });
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .slice(0, MAX_PROTOCOL_ITEMS)
    .map(item => text(item, 128))
    .filter((item): item is string => item !== undefined));
}

function knownVersionList(value: unknown): readonly ProtocolKnownVersion[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .slice(0, MAX_PROTOCOL_ITEMS)
    .flatMap(item => {
      if (!isRecord(item)) return [];
      const key = text(item.key, 128);
      const version = text(item.version, 128);
      return key && version ? [Object.freeze({ key, version })] : [];
    }));
}

function requestAnchor(
  events: readonly FluxDiagnosticEvent[]
): FluxDiagnosticEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event.data)) continue;
    if (event.type === "server-trace") return event;
    if (event.type === "transport" && event.data.phase === "start") return event;
  }
  return undefined;
}

function sameRequest(
  event: FluxDiagnosticEvent,
  anchor: FluxDiagnosticEvent
): boolean {
  const anchorCorrelation = correlation(anchor);
  return anchorCorrelation === null
    ? event.id === anchor.id
    : correlation(event) === anchorCorrelation;
}

function emptyResponse(): ProtocolResponseSummary {
  return {
    resourceObservations: 0,
    resourcesSent: 0,
    resourcesOmitted: 0,
    deferred: 0,
    errors: 0,
    patchResources: 0,
    invalidations: 0,
    liveSignals: 0,
  };
}

function pageResponse(
  data: Record<string, unknown>
): ProtocolResponseSummary {
  const resources = (Array.isArray(data.resources) ? data.resources : [])
    .slice(0, 256)
    .filter(isRecord);
  return {
    resourceObservations: resources.length,
    resourcesSent: resources.filter(item => item.sent === true).length,
    resourcesOmitted: resources.filter(item => (
      item.result === "omitted-known" ||
      (item.knownVersion === true && item.sent === false)
    )).length,
    deferred: resources.filter(item => (
      item.result === "deferred" || item.deferred === true
    )).length,
    errors: resources.filter(item => item.result === "error").length,
    patchResources: 0,
    invalidations: 0,
    liveSignals: 0,
  };
}

function mutationResponse(
  data: Record<string, unknown>
): ProtocolResponseSummary {
  return {
    resourceObservations: 0,
    resourcesSent: 0,
    resourcesOmitted: 0,
    deferred: 0,
    errors: 0,
    patchResources: Array.isArray(data.patches)
      ? Math.min(data.patches.length, MAX_PROTOCOL_ITEMS)
      : 0,
    invalidations: integer(data.invalidationCount) ?? 0,
    liveSignals: integer(data.liveSignals) ?? 0,
  };
}

/** Derive a safe, human-readable view of the latest FluxFast request. */
export function deriveProtocolRequest(
  events: readonly FluxDiagnosticEvent[]
): ProtocolRequestInsight | null {
  const anchor = requestAnchor(events);
  if (!anchor || !isRecord(anchor.data)) return null;
  const related = events.filter(event => sameRequest(event, anchor));
  const start = related.find(event => (
    event.type === "transport" &&
    isRecord(event.data) &&
    event.data.phase === "start"
  ));
  const finish = [...related].reverse().find(event => (
    event.type === "transport" &&
    isRecord(event.data) &&
    (event.data.phase === "success" || event.data.phase === "error")
  ));
  const trace = [...related].reverse().find(event => event.type === "server-trace");
  const startData = start && isRecord(start.data) ? start.data : {};
  const finishData = finish && isRecord(finish.data) ? finish.data : {};
  const traceData = trace && isRecord(trace.data) ? trace.data : {};
  const requestType = startData.requestType === "mutation" ||
      traceData.type === "mutation"
    ? "mutation"
    : "page";
  const finishPhase = text(finishData.phase, 64);
  const source = traceData.source === "ssr" ? "ssr" : "browser";
  const status = finishPhase === "success" || finishPhase === "error"
    ? finishPhase
    : source === "ssr"
      ? "success"
      : "pending";
  const traceStatus = text(finishData.serverTrace, 32);
  const serverTrace = traceStatus === "missing" ||
      traceStatus === "valid" ||
      traceStatus === "invalid" ||
      traceStatus === "unsupported"
    ? traceStatus
    : trace
      ? "valid"
      : "pending";
  const response = traceData.type === "mutation"
    ? mutationResponse(traceData)
    : traceData.type === "page"
      ? pageResponse(traceData)
      : emptyResponse();
  const id = correlation(anchor) ?? anchor.id;

  return Object.freeze({
    id,
    correlationId: correlation(anchor),
    timestamp: timestamp(start?.timestamp ?? trace?.timestamp ?? anchor.timestamp),
    requestType,
    method: text(startData.method, 32) ?? (requestType === "page" ? "GET" : "POST"),
    path: path(startData.path) ?? path(traceData.path) ?? "/",
    status,
    httpStatus: integer(finishData.status) ?? null,
    durationMs: number(finishData.durationMs) ?? number(traceData.durationMs) ?? null,
    protocol: text(startData.protocol, 64) ?? "fluxfast/1",
    diagnosticProtocol: text(traceData.protocol, 64) ??
      text(finishData.serverTraceProtocol, 64) ?? null,
    capabilities: stringList(startData.capabilities),
    knownVersions: knownVersionList(startData.knownVersions),
    only: stringList(startData.only),
    serverTrace,
    response: Object.freeze(response),
    truncated: traceData.truncated === true,
    source,
  });
}

export function abbreviatedVersion(version: string): string {
  return version.length <= 14 ? version : `${version.slice(0, 11)}…`;
}
