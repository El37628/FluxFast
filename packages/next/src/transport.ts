/** Server-only runtime transport proxy for production FluxFast requests. */

import { resolveFluxBackendUrl } from "./config.js";
import { createFluxTransportProxy } from "@fluxfast/core/server";

export interface FluxTransportHandlerOptions {
  backendUrl?: string;
  fetch?: typeof fetch;
}

export interface FluxTransportRouteContext {
  params:
    | Promise<{ path?: string[] }>
    | { path?: string[] };
}

function safePath(segments: string[] | undefined): string | undefined {
  if (!segments?.length) return "/";
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    return undefined;
  }
  return `/${segments.map(encodeURIComponent).join("/")}`;
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
  const proxy = createFluxTransportProxy({
    // Core owns HTTP mechanics; the adapter supplies its per-request address.
    // The getter is not read for requests rejected by the shared proxy.
    get backendUrl() { return resolveFluxBackendUrl(options.backendUrl); },
    fetch: options.fetch ?? globalThis.fetch,
  });

  return async function fluxTransportHandler(
    request: Request,
    context: FluxTransportRouteContext
  ): Promise<Response> {
    const { path: segments } = await context.params;
    const pathname = safePath(segments);
    return proxy(request, pathname ?? "");
  };
}
