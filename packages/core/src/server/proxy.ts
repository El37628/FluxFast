import { removeFluxHopByHopHeaders } from "./headers.js";
import type { FluxTransportProxyOptions } from "./types.js";

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function safePathname(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f?#]/.test(path)) {
    return false;
  }
  try {
    // WHATWG URL parsing normalizes even percent-encoded dot segments. Reject
    // them before construction so a caller cannot escape a backend path prefix.
    return path.split("/").every(segment => {
      const decoded = decodeURIComponent(segment);
      return decoded !== "." && decoded !== "..";
    });
  } catch {
    return false;
  }
}

function targetUrl(backendUrl: string, pathname: string, search: string): string {
  const backend = new URL(backendUrl);
  if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password || backend.search || backend.hash) {
    throw new TypeError("Invalid FluxFast backend URL");
  }
  const target = backendUrl.replace(/\/$/, "") + pathname + search;
  if (new URL(target).origin !== backend.origin) {
    throw new TypeError("Invalid FluxFast transport target");
  }
  return target;
}

/**
 * Proxy an encoded, origin-relative pathname using only standard Web APIs.
 * The incoming request supplies its query, method, headers, body, and signal.
 * Redirects remain manual and response bodies remain streaming.
 */
export function createFluxTransportProxy(
  options: FluxTransportProxyOptions
): (request: Request, path: string) => Promise<Response> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return async function fluxTransportProxy(request: Request, path: string): Promise<Response> {
    if (request.headers.get("x-fluxfast") !== "1") {
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (!safePathname(path)) {
      return jsonError(400, "invalid_transport_path", "Invalid FluxFast path");
    }

    const method = request.method.toUpperCase();
    // Preserve the existing mutation buffering and native body-read errors.
    // Only response bodies are required to remain streaming (including SSE).
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    try {
      const target = targetUrl(options.backendUrl, path, new URL(request.url).search);
      const headers = removeFluxHopByHopHeaders(request.headers);
      // Let fetch negotiate encoding without forwarding mismatched metadata.
      headers.delete("accept-encoding");
      const upstream = await fetchImplementation(target, {
        method, headers, body, cache: "no-store", redirect: "manual", signal: request.signal,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: removeFluxHopByHopHeaders(upstream.headers),
      });
    } catch {
      // Never expose private addresses, credentials, or native exception text.
      return jsonError(503, "transport_unavailable", "FluxFast backend is unavailable");
    }
  };
}
