/** Server-only runtime transport proxy for production FluxFast requests. */

import { resolveFluxBackendUrl } from "./config";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

export interface FluxTransportHandlerOptions {
  backendUrl?: string;
  fetch?: typeof fetch;
}

export interface FluxTransportRouteContext {
  params:
    | Promise<{ path?: string[] }>
    | { path?: string[] };
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function safePath(segments: string[] | undefined): string | undefined {
  if (!segments?.length) return "/";
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    return undefined;
  }
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  // Let the server-side fetch implementation negotiate an encoding that it
  // can forward without mismatched compression metadata.
  headers.delete("accept-encoding");
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return headers;
}

/**
 * Create the handler used by the generated production transport route.
 *
 * The private backend address is resolved for every request, so `fluxfast
 * start --backend-port ...` never has to match a value embedded during the
 * frontend build. The upstream response body remains streaming for Live
 * Resource event streams.
 */
export function createFluxTransportHandler(
  options: FluxTransportHandlerOptions = {}
): (
  request: Request,
  context: FluxTransportRouteContext
) => Promise<Response> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return async function fluxTransportHandler(
    request: Request,
    context: FluxTransportRouteContext
  ): Promise<Response> {
    if (request.headers.get("x-fluxfast") !== "1") {
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }

    const { path: segments } = await context.params;
    const pathname = safePath(segments);
    if (!pathname) {
      return jsonError(400, "invalid_transport_path", "Invalid FluxFast path");
    }

    const source = new URL(request.url);
    const target = `${resolveFluxBackendUrl(options.backendUrl)}${pathname}${source.search}`;
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

    try {
      const upstream = await fetchImplementation(target, {
        method,
        headers: forwardedHeaders(request),
        body,
        cache: "no-store",
        redirect: "manual",
        signal: request.signal,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream),
      });
    } catch {
      return jsonError(
        503,
        "transport_unavailable",
        "FluxFast backend is unavailable"
      );
    }
  };
}
