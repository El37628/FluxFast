import { HEADER_CAPABILITIES, serializeCapabilities } from "../capabilities.js";
import { TransportError } from "../errors.js";
import { PROTOCOL_MEDIA_TYPE } from "../protocol.js";
import {
  assertPageEnvelope, decodeServerDiagnosticTrace, HEADER_DEVTOOLS, HEADER_DEVTOOLS_TRACE,
} from "../transport.js";
import { removeFluxHopByHopHeaders } from "./headers.js";
import {
  DEFAULT_MAX_INITIAL_REDIRECTS, isFluxRedirectStatus, resolveFluxRedirect,
} from "./redirect.js";
import type { FetchFluxInitialPageOptions, FluxInitialPageResult } from "./types.js";

// Error bodies are untrusted diagnostics, not application resource payloads.
const MAX_INITIAL_ERROR_BYTES = 1024 * 1024;

function initialTarget(backendUrl: string, path: string): { fullUrl: string; origin: string } {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) {
    throw new TypeError("FluxFast initial paths must be origin-relative");
  }
  let backend: URL;
  try {
    backend = new URL(backendUrl);
  } catch {
    throw new TypeError("FluxFast backendUrl must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password || backend.search || backend.hash) {
    throw new TypeError("FluxFast backendUrl must be a valid HTTP(S) URL without credentials, query, or fragment");
  }
  const fullUrl = `${backendUrl.replace(/\/$/, "")}${path}`;
  if (new URL(fullUrl).origin !== backend.origin) {
    throw new TypeError("FluxFast initial paths must be origin-relative");
  }
  return { fullUrl, origin: backend.origin };
}

async function readErrorJson(response: Response): Promise<unknown> {
  if (!response.body) return JSON.parse("");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_INITIAL_ERROR_BYTES) {
        // A host may retain another tee branch. Initiate cancellation, but do
        // not wait for a reader that we do not own before rejecting the body.
        void reader.cancel().catch(() => {});
        throw new TransportError("Initial FluxFast error response exceeded the size limit", response.status);
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } finally {
    reader.releaseLock();
  }
}

/** Fetch an initial envelope without owning framework rendering or environment policy. */
export async function fetchFluxInitialPage({
  backendUrl, path, headers = {}, fetch: fetchImplementation = globalThis.fetch,
  diagnostics = false, maxRedirects = DEFAULT_MAX_INITIAL_REDIRECTS,
}: FetchFluxInitialPageOptions): Promise<FluxInitialPageResult> {
  const { fullUrl, origin } = initialTarget(backendUrl, path);
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError("FluxFast maxRedirects must be a non-negative safe integer");
  }
  const requestHeaders = removeFluxHopByHopHeaders(headers);
  requestHeaders.set("Accept", PROTOCOL_MEDIA_TYPE);
  requestHeaders.set("X-FluxFast", "1");
  requestHeaders.set("X-FluxFast-Protocol", "1");
  requestHeaders.set("X-FluxFast-Visit", `ssr_${Date.now().toString(36)}`);
  requestHeaders.set(HEADER_CAPABILITIES, serializeCapabilities());
  requestHeaders.delete(HEADER_DEVTOOLS);
  if (diagnostics === true) requestHeaders.set(HEADER_DEVTOOLS, "1");

  const requestInit: RequestInit = {
    method: "GET", headers: requestHeaders, cache: "no-store", redirect: "manual",
  };
  let requestUrl = fullUrl;
  let response: Response;
  for (let redirects = 0; ; redirects++) {
    response = await fetchImplementation(requestUrl, requestInit);
    const location = response.headers.get("location");
    if (!isFluxRedirectStatus(response.status) || location === null) break;
    // Cancelling a tee branch resolves only after the other branch finishes.
    // SSR hosts can retain that branch for deduplication, so awaiting it here
    // deadlocks redirect handling. Discard ours without taking ownership of
    // the host's stream; redirect validation below remains fail-closed.
    void response.body?.cancel().catch(() => {});
    if (redirects >= maxRedirects) {
      throw new TransportError("Initial FluxFast response exceeded the redirect limit", response.status);
    }
    requestUrl = resolveFluxRedirect(location, requestUrl, origin, response.status).href;
  }

  let data: unknown;
  try {
    data = response.ok ? await response.json() : await readErrorJson(response);
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError(
      `Failed to parse initial FluxFast response from ${fullUrl} (HTTP ${response.status})`,
      response.status
    );
  }
  if (response.status === 404) return { type: "not-found" };
  if (!response.ok) {
    const detail = data as { error?: { message?: unknown }; detail?: unknown } | null;
    const message = detail?.error?.message ?? detail?.detail;
    throw new TransportError(
      typeof message === "string" ? message
        : `Failed to fetch initial FluxFast envelope from ${fullUrl} (HTTP ${response.status})`,
      response.status, data
    );
  }
  assertPageEnvelope(data);
  const trace = diagnostics === true
    ? decodeServerDiagnosticTrace(response.headers.get(HEADER_DEVTOOLS_TRACE)) : undefined;
  return {
    type: "page", envelope: data,
    ...(trace === undefined ? {} : {
      development: {
        initialPath: new URL(path, "http://fluxfast.local").pathname.slice(0, 2_048) || "/",
        initialServerTrace: trace,
      },
    }),
  };
}
