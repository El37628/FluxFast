import { decodeServerDiagnosticTrace } from "@fluxfast/core";
import type { FluxCacheConfig, FluxDevelopmentMetadata } from "./config.js";

/** Private payload validation shared by the host and browser entry. */
export function readFluxCacheConfig(value: unknown): FluxCacheConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid FluxFast hydration cache configuration");
  }
  const source = value as Record<string, unknown>;
  const cache: FluxCacheConfig = {};
  for (const name of ["maxResources", "maxPages"] as const) {
    if (Object.hasOwn(source, name)) {
      const limit = source[name];
      if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
        throw new TypeError("Invalid FluxFast hydration cache configuration");
      }
      cache[name] = limit as number;
    }
  }
  return cache;
}

export function readFluxDevelopmentMetadata(value: unknown): FluxDevelopmentMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid FluxFast hydration development metadata");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.initialPath !== "string" || !source.initialPath.startsWith("/") || source.initialPath.length > 2_048) {
    throw new TypeError("Invalid FluxFast hydration development metadata");
  }
  const json = JSON.stringify(source.initialServerTrace);
  if (typeof json !== "string" || json.length > 16_384) {
    throw new TypeError("Invalid FluxFast hydration development metadata");
  }
  const bytes = new TextEncoder().encode(json);
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const trace = decodeServerDiagnosticTrace(encoded);
  if (!trace) throw new TypeError("Invalid FluxFast hydration development metadata");
  return { initialPath: source.initialPath, initialServerTrace: trace };
}
