import type { FluxServerDiagnosticTrace } from "../transport.js";
import type { PageEnvelope } from "../protocol.js";

/** Safe development metadata, separate from the browser protocol envelope. */
export interface FluxDevelopmentMetadata {
  initialPath: string;
  initialServerTrace: FluxServerDiagnosticTrace;
}

/** Host-supplied inputs for the framework-neutral initial-page fetch. */
export interface FetchFluxInitialPageOptions {
  backendUrl: string;
  path: string;
  headers?: HeadersInit;
  fetch?: typeof fetch;
  diagnostics?: boolean;
  maxRedirects?: number;
}

/** Hosts translate not-found into their own response/rendering mechanism. */
export type FluxInitialPageResult =
  | {
      type: "page";
      envelope: PageEnvelope;
      development?: FluxDevelopmentMetadata;
    }
  | {
      type: "not-found";
    };

/** Explicit backend/fetch configuration; no framework or environment lookup. */
export interface FluxTransportProxyOptions {
  backendUrl: string;
  fetch?: typeof fetch;
}
