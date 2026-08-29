/** Framework-neutral transport abstraction and native Fetch implementation. */

import {
  ErrorEnvelope,
  MutationEnvelope,
  PageEnvelope,
  PROTOCOL_MEDIA_TYPE,
  PROTOCOL_VERSION,
} from "./protocol";
import {
  MutationError,
  ProtocolError,
  TransportError,
  ValidationError,
  VersionMismatchError,
} from "./errors";
import { HEADER_CAPABILITIES, serializeCapabilities } from "./capabilities";

const MAX_KNOWN_RESOURCES = 100;
const MAX_KNOWN_BYTES = 16 * 1024;
const MAX_KEY_LENGTH = 128;
const MAX_VERSION_LENGTH = 128;

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
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface FluxTransport {
  visit(request: VisitTransportRequest): Promise<PageEnvelope>;
  mutate(request: MutationTransportRequest): Promise<MutationEnvelope>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Return an encoded safe header, or undefined when the optimization must be omitted. */
export function encodeKnownVersions(
  knownVersions: Record<string, string> | undefined
): string | undefined {
  if (!knownVersions) return undefined;

  const safe: Record<string, string> = {};
  for (const [key, version] of Object.entries(knownVersions)) {
    if (Object.keys(safe).length >= MAX_KNOWN_RESOURCES) break;
    if (
      key.length <= MAX_KEY_LENGTH &&
      version.length <= MAX_VERSION_LENGTH
    ) {
      safe[key] = version;
    }
  }

  if (Object.keys(safe).length === 0) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(safe));
  if (bytes.byteLength > MAX_KNOWN_BYTES) return undefined;
  return encodeBase64Url(bytes);
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
  if (data.mutation.invalidate !== undefined && !Array.isArray(data.mutation.invalidate)) {
    throw new MutationError("Invalid MutationEnvelope: invalidate must be an array");
  }
  if (data.mutation.patches !== undefined && !isObject(data.mutation.patches)) {
    throw new MutationError("Invalid MutationEnvelope: patches must be an object");
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
      const hasIdentity = "id" in patch || (
        isObject(patch.match) && Object.keys(patch.match).length > 0
      );
      if (
        (["replace-resource", "merge-object", "append-item"].includes(patch.op) && !("value" in patch)) ||
        (["replace-item", "remove-item"].includes(patch.op) && !hasIdentity) ||
        (patch.op === "replace-item" && !("value" in patch))
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

export class FetchTransport implements FluxTransport {
  private readonly baseUrl: string;

  constructor(baseUrl: string = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async visit(request: VisitTransportRequest): Promise<PageEnvelope> {
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      Accept: PROTOCOL_MEDIA_TYPE,
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      "X-FluxFast-Visit": request.visitId,
      [HEADER_CAPABILITIES]: serializeCapabilities(),
    };
    const encodedKnown = encodeKnownVersions(request.knownVersions);
    if (encodedKnown) headers["X-FluxFast-Known"] = encodedKnown;
    if (request.only?.length) {
      const only = request.only
        .filter(key => key.length <= MAX_KEY_LENGTH && !key.includes(",") && !/[\u0000-\u001f]/.test(key))
        .slice(0, MAX_KNOWN_RESOURCES);
      if (only.length) headers["X-FluxFast-Only"] = only.join(",");
    }

    const response = await fetch(this.resolveUrl(request.url), {
      method: "GET",
      headers,
      signal: request.signal,
      credentials: "include",
    });
    return this.handlePageResponse(response);
  }

  async mutate(request: MutationTransportRequest): Promise<MutationEnvelope> {
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      Accept: PROTOCOL_MEDIA_TYPE,
      "Content-Type": "application/json",
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      [HEADER_CAPABILITIES]: serializeCapabilities(),
    };
    const response = await fetch(this.resolveUrl(request.url), {
      method: request.method ?? "POST",
      headers,
      body: request.data === undefined ? undefined : JSON.stringify(request.data),
      signal: request.signal,
      credentials: "include",
    });
    return this.handleMutationResponse(response);
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
    }
    return data;
  }
}

export function createFetchTransport(baseUrl: string = ""): FetchTransport {
  return new FetchTransport(baseUrl);
}
