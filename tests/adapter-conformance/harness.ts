import type {
  FluxDiagnosticEvent, MutationEnvelope, PageEnvelope, PageState,
  ResourceMetadataSnapshot, ResourceStateSnapshot, VisitOptions,
} from "@fluxfast/core";

/** Host lifecycle only. Contract tests do not import a frontend framework. */
export interface FluxAdapterTestHarness {
  readonly name: string;
  readonly baseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  build?(): Promise<void>;
}

/** Test-owned browser facade over public Core APIs, not adapter internals. */
export interface FluxConformanceBridge {
  page(): PageState;
  resource(key: string): ResourceStateSnapshot;
  records(): readonly ResourceMetadataSnapshot[];
  knownVersions(): Record<string, string>;
  visit(url: string, options?: VisitOptions): Promise<void>;
  prefetch(url: string): Promise<PageEnvelope>;
  refresh(only?: string[]): Promise<void>;
  retry(key: string): Promise<void>;
  mutate(url: string, data?: unknown): Promise<MutationEnvelope>;
  diagnostics(): readonly FluxDiagnosticEvent[];
  initialEnvelope(): PageEnvelope | undefined;
}

declare global {
  interface Window {
    fluxConformanceEnabled?: boolean;
    fluxAdapterConformance?: FluxConformanceBridge;
  }
}
