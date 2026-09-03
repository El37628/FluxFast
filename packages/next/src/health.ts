/** Server-only handler for public, same-origin FluxFast health checks. */

import { resolveFluxBackendUrl } from "./config.js";

const HEALTH_PREFIX = "/_fluxfast/";
const HEALTH_PROBES = new Set(["healthz", "readyz"]);
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

export interface FluxHealthHandlerOptions {
  backendUrl?: string;
  timeoutMs?: number;
}

type HealthStatus = "ok" | "ready" | "not_ready";

function jsonResponse(status: HealthStatus, statusCode: number): Response {
  return new Response(JSON.stringify({ status }), {
    status: statusCode,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function unavailableResponse(): Response {
  return jsonResponse("not_ready", 503);
}

function probeFromRequest(request: Request): "healthz" | "readyz" | undefined {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  const marker = pathname.lastIndexOf(HEALTH_PREFIX);
  if (marker < 0) return undefined;
  const probe = pathname.slice(marker + HEALTH_PREFIX.length);
  return HEALTH_PROBES.has(probe) ? probe as "healthz" | "readyz" : undefined;
}

function validPayload(value: unknown): value is { status: HealthStatus } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    ((value as { status?: unknown }).status === "ok" ||
      (value as { status?: unknown }).status === "ready" ||
      (value as { status?: unknown }).status === "not_ready")
  );
}

/**
 * Create the GET handler used by the generated `/_fluxfast/[probe]` route.
 *
 * The private backend address is resolved when a request arrives, rather than
 * being embedded in the Next.js build output. Only the documented minimal
 * health payloads are returned; transport failures and malformed upstream
 * responses are collapsed into a non-sensitive 503 response.
 */
export function createFluxHealthHandler(
  options: FluxHealthHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("FluxFast health timeoutMs must be a positive number");
  }

  return async function fluxHealthHandler(request: Request): Promise<Response> {
    const probe = probeFromRequest(request);
    if (!probe) {
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }

    try {
      const backendUrl = resolveFluxBackendUrl(options.backendUrl);
      const upstream = await fetch(`${backendUrl}${HEALTH_PREFIX}${probe}`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload: unknown = await upstream.json();
      if (!validPayload(payload)) return unavailableResponse();

      if (probe === "healthz" && upstream.status === 200 && payload.status === "ok") {
        return jsonResponse("ok", 200);
      }
      if (
        probe === "readyz" &&
        ((upstream.status === 200 && payload.status === "ready") ||
          (upstream.status === 503 && payload.status === "not_ready"))
      ) {
        return jsonResponse(payload.status, upstream.status);
      }
      return unavailableResponse();
    } catch {
      return unavailableResponse();
    }
  };
}
