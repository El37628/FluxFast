/** Framework-neutral transport abstraction and native Fetch implementation. */

import {
  ErrorEnvelope,
  MutationEnvelope,
  PageEnvelope,
  PROTOCOL_MEDIA_TYPE,
  PROTOCOL_VERSION,
} from "./protocol.js";
import {
  MutationError,
  ProtocolError,
  TransportError,
  ValidationError,
  VersionMismatchError,
} from "./errors.js";
import {
  FLUX_CAPABILITIES,
  HEADER_CAPABILITIES,
  serializeCapabilities,
} from "./capabilities.js";
import {
  FluxDiagnosticsHub,
  type FluxDiagnosticEventType,
} from "./diagnostics.js";
import {
  diagnosticErrorType,
  diagnosticText,
} from "./diagnostic-safety.js";
import { assertClientId, HEADER_CLIENT_ID } from "./live/client-id.js";

const MAX_KNOWN_RESOURCES = 100;
const MAX_KNOWN_BYTES = 16 * 1024;
const MAX_KEY_LENGTH = 128;
const MAX_VERSION_LENGTH = 128;
const MAX_ONLY_HEADER_BYTES = 16 * 1024;
/** Independent development trace protocol understood by this client. */
export const DEVTOOLS_PROTOCOL_VERSION = "fluxfast-devtools/1";
/** Exact opt-in request header for development traces. */
export const HEADER_DEVTOOLS = "X-FluxFast-DevTools";
/** Bounded response header carrying development trace metadata. */
export const HEADER_DEVTOOLS_TRACE = "X-FluxFast-DevTools-Trace";
/** Maximum encoded trace size accepted by browser and SSR transports. */
export const MAX_DEVTOOLS_TRACE_HEADER_CHARS = 7 * 1024;
const MAX_DEVTOOLS_TRACE_RESOURCES = 256;
const MAX_DEVTOOLS_TRACE_MUTATION_KEYS = 100;
const MAX_DEVTOOLS_DURATION_MS = 86_400_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export interface VisitTransportRequest {
  url: string;
  visitId: string;
  knownVersions?: Record<string, string>;
  only?: string[];
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface MutationTransportRequest {
  url: string;
  method?: string;
  data?: unknown;
  clientId?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  diagnosticCorrelationId?: string;
}

export interface FluxTransport {
  visit(request: VisitTransportRequest): Promise<PageEnvelope>;
  mutate(request: MutationTransportRequest): Promise<MutationEnvelope>;
  attachDiagnostics?(diagnostics: FluxDiagnosticsHub): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function isSafeDiagnosticText(
  value: unknown,
  maximumLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isSafeDiagnosticNumber(
  value: unknown,
  maximum: number = MAX_DEVTOOLS_DURATION_MS
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function decodeBase64Url(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_DEVTOOLS_TRACE_HEADER_CHARS ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }
  try {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function sanitizeResourceTrace(value: unknown): Record<string, unknown> | undefined {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "key",
      "result",
      "durationMs",
      "scope",
      "ttl",
      "deferred",
      "live",
      "cacheBackend",
      "cacheResult",
      "sent",
      "knownVersion",
      "cacheMs",
      "loaderMs",
      "errorType",
    ]) ||
    !isSafeResourceKey(value.key) ||
    typeof value.result !== "string" ||
    !["cache-hit", "cache-miss", "loader", "deferred", "omitted-known", "error"]
      .includes(value.result) ||
    !isSafeDiagnosticNumber(value.durationMs) ||
    typeof value.scope !== "string" ||
    !["public", "user", "tenant", "request", "custom"]
      .includes(value.scope) ||
    !isSafeDiagnosticNumber(value.ttl, 1_000_000_000_000) ||
    typeof value.deferred !== "boolean" ||
    typeof value.live !== "boolean" ||
    typeof value.cacheBackend !== "string" ||
    !["memory", "redis", "custom"].includes(value.cacheBackend) ||
    typeof value.cacheResult !== "string" ||
    !["hit", "miss", "bypass"].includes(value.cacheResult) ||
    typeof value.sent !== "boolean" ||
    typeof value.knownVersion !== "boolean" ||
    (value.cacheMs !== undefined && !isSafeDiagnosticNumber(value.cacheMs)) ||
    (value.loaderMs !== undefined && !isSafeDiagnosticNumber(value.loaderMs)) ||
    (value.errorType !== undefined && (
      typeof value.errorType !== "string" ||
      ![
        "ResourceError",
        "ResourceContractError",
        "ResourceCacheError",
      ].includes(value.errorType)
    ))
  ) {
    return undefined;
  }
  return {
    key: value.key,
    result: value.result,
    durationMs: value.durationMs,
    scope: value.scope,
    ttl: value.ttl,
    deferred: value.deferred,
    live: value.live,
    cacheBackend: value.cacheBackend,
    cacheResult: value.cacheResult,
    sent: value.sent,
    knownVersion: value.knownVersion,
    ...(value.cacheMs === undefined ? {} : { cacheMs: value.cacheMs }),
    ...(value.loaderMs === undefined ? {} : { loaderMs: value.loaderMs }),
    ...(value.errorType === undefined ? {} : { errorType: value.errorType }),
  };
}

function sanitizePatchTrace(value: unknown): Record<string, unknown> | undefined {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["key", "operations"]) ||
    !isSafeResourceKey(value.key) ||
    !isObject(value.operations) ||
    !hasOnlyKeys(value.operations, [
      "replace-resource",
      "merge-object",
      "replace-item",
      "remove-item",
      "append-item",
    ])
  ) {
    return undefined;
  }
  const operations: Record<string, number> = {};
  for (const [operation, count] of Object.entries(value.operations)) {
    if (!Number.isSafeInteger(count) || (count as number) <= 0 || (count as number) > 1_000_000) {
      return undefined;
    }
    operations[operation] = count as number;
  }
  return { key: value.key, operations };
}

/** A strictly validated, value-free backend diagnostic trace. */
export type FluxServerDiagnosticTrace = Readonly<Record<string, unknown>>;

function sanitizeServerTrace(value: unknown): FluxServerDiagnosticTrace | undefined {
  if (
    !isObject(value) ||
    value.protocol !== DEVTOOLS_PROTOCOL_VERSION ||
    !isSafeDiagnosticText(value.requestId, 96) ||
    !/^ffdev_[A-Za-z0-9_-]+$/.test(value.requestId) ||
    typeof value.type !== "string" ||
    !["page", "mutation"].includes(value.type) ||
    !isSafeDiagnosticNumber(value.durationMs) ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }

  const common = {
    protocol: DEVTOOLS_PROTOCOL_VERSION,
    requestId: value.requestId,
    type: value.type,
    durationMs: value.durationMs,
    truncated: value.truncated,
  };
  if (value.type === "page") {
    if (
      !hasOnlyKeys(value, [
        "protocol",
        "requestId",
        "type",
        "durationMs",
        "pageMs",
        "resourcesMs",
        "serializeMs",
        "resources",
        "truncated",
      ]) ||
      !isSafeDiagnosticNumber(value.pageMs) ||
      !isSafeDiagnosticNumber(value.resourcesMs) ||
      !isSafeDiagnosticNumber(value.serializeMs) ||
      !Array.isArray(value.resources) ||
      value.resources.length > MAX_DEVTOOLS_TRACE_RESOURCES
    ) {
      return undefined;
    }
    const resources = value.resources.map(sanitizeResourceTrace);
    if (resources.some(resource => resource === undefined)) return undefined;
    return {
      ...common,
      pageMs: value.pageMs,
      resourcesMs: value.resourcesMs,
      serializeMs: value.serializeMs,
      resources,
    };
  }

  if (
    !hasOnlyKeys(value, [
      "protocol",
      "requestId",
      "type",
      "durationMs",
      "handlerMs",
      "invalidationMs",
      "serializeMs",
      "patches",
      "invalidated",
      "invalidationCount",
      "liveSignals",
      "redirect",
      "truncated",
    ]) ||
    !isSafeDiagnosticNumber(value.handlerMs) ||
    !isSafeDiagnosticNumber(value.invalidationMs) ||
    !isSafeDiagnosticNumber(value.serializeMs) ||
    !Array.isArray(value.patches) ||
    value.patches.length > MAX_DEVTOOLS_TRACE_MUTATION_KEYS ||
    !Array.isArray(value.invalidated) ||
    value.invalidated.length > MAX_DEVTOOLS_TRACE_MUTATION_KEYS ||
    value.invalidated.some(key => !isSafeResourceKey(key)) ||
    !Number.isSafeInteger(value.invalidationCount) ||
    (value.invalidationCount as number) < value.invalidated.length ||
    (value.invalidationCount as number) > 1_000_000 ||
    !Number.isSafeInteger(value.liveSignals) ||
    (value.liveSignals as number) < 0 ||
    (value.liveSignals as number) > 1_000_000 ||
    typeof value.redirect !== "string" ||
    !["none", "internal", "external"].includes(value.redirect)
  ) {
    return undefined;
  }
  const patches = value.patches.map(sanitizePatchTrace);
  if (patches.some(patch => patch === undefined)) return undefined;
  return {
    ...common,
    handlerMs: value.handlerMs,
    invalidationMs: value.invalidationMs,
    serializeMs: value.serializeMs,
    patches,
    invalidated: [...value.invalidated],
    invalidationCount: value.invalidationCount,
    liveSignals: value.liveSignals,
    redirect: value.redirect,
  };
}

interface DiagnosticTraceObservation {
  readonly status: "missing" | "valid" | "invalid" | "unsupported";
  readonly protocol?: string;
}

interface InspectedServerTrace extends DiagnosticTraceObservation {
  readonly trace?: FluxServerDiagnosticTrace;
}

function inspectServerDiagnosticTrace(value: string): InspectedServerTrace {
  const decoded = decodeBase64Url(value);
  if (decoded === undefined) return { status: "invalid" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { status: "invalid" };
  }
  if (
    isObject(parsed) &&
    isSafeDiagnosticText(parsed.protocol, 64) &&
    parsed.protocol !== DEVTOOLS_PROTOCOL_VERSION &&
    /^[a-z][a-z0-9-]*\/\d+$/.test(parsed.protocol)
  ) {
    return { status: "unsupported", protocol: parsed.protocol };
  }
  const trace = sanitizeServerTrace(parsed);
  return trace ? { status: "valid", trace } : { status: "invalid" };
}

/** Decode and strictly validate one bounded development trace header. */
export function decodeServerDiagnosticTrace(
  value: string | null
): FluxServerDiagnosticTrace | undefined {
  if (value === null) return undefined;
  return inspectServerDiagnosticTrace(value).trace;
}

function isSafeResourceKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_KEY_LENGTH &&
    !value.includes(",") &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isOriginRelativeRedirect(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function selectKnownVersions(
  knownVersions: Record<string, string> | undefined
): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!knownVersions) return safe;
  for (const [key, version] of Object.entries(knownVersions)) {
    if (Object.keys(safe).length >= MAX_KNOWN_RESOURCES) break;
    if (
      isSafeResourceKey(key) &&
      typeof version === "string" &&
      version.length <= MAX_VERSION_LENGTH &&
      !CONTROL_CHARACTERS.test(version)
    ) {
      safe[key] = version;
    }
  }
  return safe;
}

function encodeKnownVersionSelection(
  safe: Record<string, string>
): string | undefined {
  if (Object.keys(safe).length === 0) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(safe));
  if (bytes.byteLength > MAX_KNOWN_BYTES) return undefined;
  return encodeBase64Url(bytes);
}

/** Return an encoded safe header, or undefined when the optimization must be omitted. */
export function encodeKnownVersions(
  knownVersions: Record<string, string> | undefined
): string | undefined {
  return encodeKnownVersionSelection(selectKnownVersions(knownVersions));
}

function selectOnlyResources(only: string[] | undefined): string[] {
  if (!only) return [];
  const safe = only.filter(isSafeResourceKey).slice(0, MAX_KNOWN_RESOURCES);
  if (
    safe.length === 0 ||
    new TextEncoder().encode(safe.join(",")).byteLength > MAX_ONLY_HEADER_BYTES
  ) {
    return [];
  }
  return safe;
}

export function assertPageEnvelope(data: unknown): asserts data is PageEnvelope {
  if (!isObject(data) || data.protocol !== PROTOCOL_VERSION) {
    const received = isObject(data) ? data.protocol : undefined;
    throw new VersionMismatchError(
      `Protocol mismatch: expected '${PROTOCOL_VERSION}', got '${String(received)}'`
    );
  }
  if (!isObject(data.page) || typeof data.page.component !== "string" || typeof data.page.url !== "string") {
    throw new ProtocolError("Invalid PageEnvelope: page descriptor is missing or malformed");
  }
  if (!isObject(data.resources)) {
    throw new ProtocolError("Invalid PageEnvelope: resources must be an object");
  }
  for (const [key, record] of Object.entries(data.resources)) {
    if (!isObject(record) || typeof record.version !== "string" || !("value" in record)) {
      throw new ProtocolError(`Invalid PageEnvelope resource record for '${key}'`);
    }
  }
  for (const field of ["resourceKeys", "deferred", "live"] as const) {
    const value = data[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((key) => typeof key !== "string"))
    ) {
      throw new ProtocolError(`Invalid PageEnvelope: ${field} must be an array of strings`);
    }
  }
  if (data.resourceErrors !== undefined) {
    if (!isObject(data.resourceErrors)) {
      throw new ProtocolError("Invalid PageEnvelope: resourceErrors must be an object");
    }
    for (const [key, error] of Object.entries(data.resourceErrors)) {
      if (
        !isObject(error) ||
        typeof error.type !== "string" ||
        typeof error.message !== "string"
      ) {
        throw new ProtocolError(`Invalid PageEnvelope resource error for '${key}'`);
      }
    }
  }
  if (data.appVersion !== undefined && typeof data.appVersion !== "string") {
    throw new ProtocolError("Invalid PageEnvelope: appVersion must be a string");
  }
}

export function assertMutationEnvelope(data: unknown): asserts data is MutationEnvelope {
  if (!isObject(data) || data.protocol !== PROTOCOL_VERSION) {
    const received = isObject(data) ? data.protocol : undefined;
    throw new VersionMismatchError(
      `Protocol mismatch: expected '${PROTOCOL_VERSION}', got '${String(received)}'`
    );
  }
  if (!isObject(data.mutation)) {
    throw new MutationError("Invalid MutationEnvelope: mutation payload is missing");
  }
  if (
    data.mutation.invalidate !== undefined &&
    (!Array.isArray(data.mutation.invalidate) ||
      data.mutation.invalidate.some(key => typeof key !== "string"))
  ) {
    throw new MutationError(
      "Invalid MutationEnvelope: invalidate must be an array of strings"
    );
  }
  if (data.mutation.patches !== undefined && !isObject(data.mutation.patches)) {
    throw new MutationError("Invalid MutationEnvelope: patches must be an object");
  }
  if (
    data.mutation.redirect !== undefined &&
    !isOriginRelativeRedirect(data.mutation.redirect)
  ) {
    throw new MutationError(
      "Invalid MutationEnvelope: redirect must be origin-relative"
    );
  }
  if (data.mutation.externalRedirect !== undefined) {
    let external: URL;
    try {
      external = new URL(String(data.mutation.externalRedirect));
    } catch {
      throw new MutationError(
        "Invalid MutationEnvelope: externalRedirect must be an absolute HTTP(S) URL"
      );
    }
    if (
      typeof data.mutation.externalRedirect !== "string" ||
      !["http:", "https:"].includes(external.protocol)
    ) {
      throw new MutationError(
        "Invalid MutationEnvelope: externalRedirect must be an absolute HTTP(S) URL"
      );
    }
  }
  const allowedOps = new Set([
    "replace-resource",
    "merge-object",
    "replace-item",
    "remove-item",
    "append-item",
  ]);
  for (const [key, patches] of Object.entries(data.mutation.patches ?? {})) {
    if (!Array.isArray(patches)) {
      throw new MutationError(`Invalid MutationEnvelope patches for '${key}'`);
    }
    for (const patch of patches) {
      if (!isObject(patch) || typeof patch.op !== "string" || !allowedOps.has(patch.op)) {
        throw new MutationError(`Invalid mutation patch operation for '${key}'`);
      }
      const hasId =
        typeof patch.id === "string" || typeof patch.id === "number";
      if ("id" in patch && !hasId) {
        throw new MutationError(`Invalid mutation patch id for '${key}'`);
      }
      if ("match" in patch && !isObject(patch.match)) {
        throw new MutationError(`Invalid mutation patch match for '${key}'`);
      }
      const hasIdentity = hasId || (
        isObject(patch.match) && Object.keys(patch.match).length > 0
      );
      if (
        (["replace-resource", "merge-object", "append-item"].includes(patch.op) && !("value" in patch)) ||
        (["replace-item", "remove-item"].includes(patch.op) && !hasIdentity) ||
        (patch.op === "replace-item" && !("value" in patch)) ||
        (patch.op === "merge-object" && !isObject(patch.value))
      ) {
        throw new MutationError(`Incomplete '${patch.op}' patch for '${key}'`);
      }
    }
  }
}

function validationDetails(data: unknown): Record<string, string[]> | undefined {
  if (!isObject(data)) return undefined;
  if (isObject(data.error) && isObject(data.error.details)) {
    return data.error.details as Record<string, string[]>;
  }
  if (!Array.isArray(data.detail)) return undefined;

  const errors: Record<string, string[]> = {};
  for (const issue of data.detail) {
    if (!isObject(issue) || !Array.isArray(issue.loc)) continue;
    const field = String(issue.loc.at(-1) ?? "general");
    (errors[field] ??= []).push(String(issue.msg ?? "Invalid value"));
  }
  return errors;
}

interface TransportDiagnosticContext {
  readonly hub: FluxDiagnosticsHub;
  readonly correlationId: string;
  readonly requestType: "page" | "mutation";
  readonly method: string;
  readonly path: string;
  readonly startedAt: number;
}

interface VisitDiagnosticMetadata {
  readonly knownVersions: readonly { key: string; version: string }[];
  readonly only: readonly string[];
}

function removeReservedDevToolsHeader(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === HEADER_DEVTOOLS.toLowerCase()) delete headers[key];
  }
}

function diagnosticPath(url: string): string {
  try {
    return diagnosticText(
      new URL(url, "http://fluxfast.local").pathname || "/",
      2_048
    );
  } catch {
    return diagnosticText(url.split(/[?#]/, 1)[0] || "/", 2_048);
  }
}

function diagnosticCorrelationId(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function diagnosticClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export class FetchTransport implements FluxTransport {
  private readonly baseUrl: string;
  private diagnostics?: FluxDiagnosticsHub;
  private diagnosticEventCounter = 0;
  private diagnosticRequestCounter = 0;

  constructor(baseUrl: string = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  attachDiagnostics(diagnostics: FluxDiagnosticsHub): void {
    this.diagnostics = diagnostics;
  }

  private resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async visit(request: VisitTransportRequest): Promise<PageEnvelope> {
    const knownVersionSelection = selectKnownVersions(request.knownVersions);
    const encodedKnown = encodeKnownVersionSelection(knownVersionSelection);
    const only = selectOnlyResources(request.only);
    const diagnostic = this.diagnostics?.active
      ? this.beginDiagnostic(
          "page",
          "GET",
          request.url,
          request.visitId,
          {
            knownVersions: encodedKnown
              ? Object.entries(knownVersionSelection).map(([key, version]) => ({
                  key,
                  version,
                }))
              : [],
            only,
          }
        )
      : undefined;
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      Accept: PROTOCOL_MEDIA_TYPE,
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      "X-FluxFast-Visit": request.visitId,
      [HEADER_CAPABILITIES]: serializeCapabilities(),
    };
    removeReservedDevToolsHeader(headers);
    if (diagnostic) headers[HEADER_DEVTOOLS] = "1";
    if (encodedKnown) headers["X-FluxFast-Known"] = encodedKnown;
    if (only.length) {
      const serializedOnly = only.join(",");
      headers["X-FluxFast-Only"] = serializedOnly;
    }

    let response: Response | undefined;
    let traceStatus: DiagnosticTraceObservation = { status: "missing" };
    try {
      response = await fetch(this.resolveUrl(request.url), {
        method: "GET",
        headers,
        signal: request.signal,
        credentials: "include",
      });
      traceStatus = this.emitServerTrace(diagnostic, response);
      const envelope = await this.handlePageResponse(response);
      this.finishDiagnostic(diagnostic, "success", response.status, traceStatus);
      return envelope;
    } catch (error) {
      this.finishDiagnostic(
        diagnostic,
        "error",
        response?.status,
        traceStatus,
        error
      );
      throw error;
    }
  }

  async mutate(request: MutationTransportRequest): Promise<MutationEnvelope> {
    assertClientId(request.clientId);
    const method = request.method ?? "POST";
    const diagnostic = this.beginDiagnostic(
      "mutation",
      method,
      request.url,
      request.diagnosticCorrelationId
    );
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      Accept: PROTOCOL_MEDIA_TYPE,
      "Content-Type": "application/json",
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      [HEADER_CAPABILITIES]: serializeCapabilities(),
    };
    removeReservedDevToolsHeader(headers);
    if (diagnostic) headers[HEADER_DEVTOOLS] = "1";
    if (request.clientId) headers[HEADER_CLIENT_ID] = request.clientId;
    let response: Response | undefined;
    let traceStatus: DiagnosticTraceObservation = { status: "missing" };
    try {
      response = await fetch(this.resolveUrl(request.url), {
        method,
        headers,
        body: request.data === undefined ? undefined : JSON.stringify(request.data),
        signal: request.signal,
        credentials: "include",
      });
      traceStatus = this.emitServerTrace(diagnostic, response);
      const envelope = await this.handleMutationResponse(response);
      this.finishDiagnostic(diagnostic, "success", response.status, traceStatus);
      return envelope;
    } catch (error) {
      this.finishDiagnostic(
        diagnostic,
        "error",
        response?.status,
        traceStatus,
        error
      );
      throw error;
    }
  }

  private beginDiagnostic(
    requestType: "page" | "mutation",
    method: string,
    url: string,
    correlationId?: string,
    visitMetadata?: VisitDiagnosticMetadata
  ): TransportDiagnosticContext | undefined {
    const hub = this.diagnostics;
    if (!hub?.active) return undefined;
    const context: TransportDiagnosticContext = {
      hub,
      correlationId: diagnosticCorrelationId(correlationId) ??
        `transport_${++this.diagnosticRequestCounter}_${Date.now().toString(36)}`,
      requestType,
      method: diagnosticText(method, 32),
      path: diagnosticPath(url),
      startedAt: diagnosticClock(),
    };
    this.emitDiagnostic(context, "transport", {
      phase: "start",
      requestType,
      method: context.method,
      path: context.path,
      protocol: PROTOCOL_VERSION,
      capabilities: [...FLUX_CAPABILITIES],
      ...(requestType === "page"
        ? {
            knownVersions: visitMetadata?.knownVersions ?? [],
            only: visitMetadata?.only ?? [],
          }
        : {}),
    });
    return context;
  }

  private emitServerTrace(
    context: TransportDiagnosticContext | undefined,
    response: Response
  ): DiagnosticTraceObservation {
    if (!context || !context.hub.active) return { status: "missing" };
    const encoded = response.headers.get(HEADER_DEVTOOLS_TRACE);
    if (encoded === null) return { status: "missing" };
    const inspected = inspectServerDiagnosticTrace(encoded);
    if (inspected.trace) {
      this.emitDiagnostic(context, "server-trace", inspected.trace);
    }
    return {
      status: inspected.status,
      ...(inspected.protocol === undefined
        ? {}
        : { protocol: inspected.protocol }),
    };
  }

  private finishDiagnostic(
    context: TransportDiagnosticContext | undefined,
    phase: "success" | "error",
    status: number | undefined,
    serverTrace: DiagnosticTraceObservation,
    error?: unknown
  ): void {
    if (!context?.hub.active) return;
    this.emitDiagnostic(context, "transport", {
      phase,
      requestType: context.requestType,
      method: context.method,
      path: context.path,
      durationMs: Math.max(0, diagnosticClock() - context.startedAt),
      ...(status === undefined ? {} : { status }),
      serverTrace: serverTrace.status,
      ...(serverTrace.protocol === undefined
        ? {}
        : { serverTraceProtocol: serverTrace.protocol }),
      ...(phase === "error"
        ? { errorType: diagnosticErrorType(error) }
        : {}),
    });
  }

  private emitDiagnostic(
    context: TransportDiagnosticContext,
    type: FluxDiagnosticEventType,
    data: unknown
  ): void {
    if (!context.hub.active) return;
    const timestamp = Date.now();
    context.hub.emit({
      id: `transport_diagnostic_${++this.diagnosticEventCounter}_${timestamp.toString(36)}`,
      timestamp,
      type,
      correlationId: context.correlationId,
      data,
    });
  }

  private async readResponse(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("json")) {
      throw new ProtocolError(
        `Expected a JSON FluxFast response from ${response.url || "request"}, got '${contentType}'`
      );
    }
    try {
      return await response.json();
    } catch {
      throw new TransportError(
        `Failed to parse JSON response from ${response.url || "request"} (status ${response.status})`,
        response.status
      );
    }
  }

  private throwForError(response: Response, data: unknown): void {
    if (response.ok) return;
    if (response.status === 422) {
      const details = validationDetails(data);
      if (details) throw new ValidationError("Request validation failed", details);
    }
    const message =
      isObject(data) && isObject(data.error) && typeof data.error.message === "string"
        ? data.error.message
        : isObject(data) && typeof data.detail === "string"
          ? data.detail
          : `Request failed with HTTP status ${response.status}`;
    throw new TransportError(message, response.status, data);
  }

  private async handlePageResponse(response: Response): Promise<PageEnvelope> {
    const data = await this.readResponse(response);
    this.throwForError(response, data);
    assertPageEnvelope(data);
    return data;
  }

  private async handleMutationResponse(response: Response): Promise<MutationEnvelope> {
    const data = await this.readResponse(response);
    this.throwForError(response, data);
    assertMutationEnvelope(data);
    const externalRedirect = response.headers.get("X-FluxFast-External-Redirect");
    if (externalRedirect && !data.mutation.externalRedirect) {
      data.mutation.externalRedirect = externalRedirect;
      assertMutationEnvelope(data);
    }
    return data;
  }
}

export function createFetchTransport(baseUrl: string = ""): FetchTransport {
  return new FetchTransport(baseUrl);
}
