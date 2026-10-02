import type { FluxServerDiagnosticTrace, PageEnvelope } from "@fluxfast/core";

export interface FluxCacheConfig {
  maxResources?: number;
  maxPages?: number;
}

/** Safe, development-only metadata captured before browser hydration. */
export interface FluxDevelopmentMetadata {
  initialPath: string;
  initialServerTrace: FluxServerDiagnosticTrace;
}

export interface FluxApplicationProps {
  initialEnvelope: PageEnvelope;
  development?: FluxDevelopmentMetadata;
  clientUrl?: string;
  cache?: FluxCacheConfig;
}
