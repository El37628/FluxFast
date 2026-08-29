import type React from "react";
import type { PageEnvelope } from "@fluxfast/core";

export interface FluxCacheConfig {
  maxResources?: number;
  maxPages?: number;
}

export interface FluxApplicationProps {
  initialEnvelope: PageEnvelope;
  clientUrl?: string;
  cache?: FluxCacheConfig;
}

export interface FluxNextConfig {
  backendUrl?: string;
  application: React.ComponentType<FluxApplicationProps>;
  clientUrl?: string;
  forwardHeaders?: string[];
  cache?: FluxCacheConfig;
}

export function defineFluxConfig<T extends FluxNextConfig>(config: T): T {
  return config;
}

export const DEFAULT_FLUXFAST_BACKEND_URL = "http://127.0.0.1:8000";

/** Resolve the server-only backend address injected by `fluxfast dev`. */
export function resolveFluxBackendUrl(configuredUrl?: string): string {
  const value = configuredUrl ??
    process.env.FLUXFAST_BACKEND_URL ??
    DEFAULT_FLUXFAST_BACKEND_URL;
  const parsed = new URL(value);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new TypeError("FluxFast backendUrl must use http or https");
  }
  return value.replace(/\/$/, "");
}
