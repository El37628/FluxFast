/** Development-only diagnostic event distribution for FluxFast tooling. */

/** High-level runtime areas that may emit diagnostic events. */
export type FluxDiagnosticEventType =
  | "navigation"
  | "resource-load"
  | "resource-update"
  | "resource-invalidate"
  | "page-cache"
  | "prefetch"
  | "mutation"
  | "deferred"
  | "live"
  | "transport"
  | "server-trace"
  | "lifecycle";

/** One structured, correlation-ready observation emitted by the runtime. */
export interface FluxDiagnosticEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly type: FluxDiagnosticEventType;
  readonly correlationId?: string;
  readonly data: unknown;
}

/** Receives one diagnostic event without participating in runtime behavior. */
export type FluxDiagnosticListener = (event: FluxDiagnosticEvent) => void;

/**
 * Fan-out channel for optional development diagnostics.
 *
 * The hub deliberately stores no timeline. Consumers such as DevTools own any
 * bounded history, while runtime hot paths can use `active` to avoid allocating
 * diagnostic events when nobody is observing them.
 */
export class FluxDiagnosticsHub {
  private readonly listeners = new Set<FluxDiagnosticListener>();

  /** Whether at least one diagnostic consumer is currently subscribed. */
  get active(): boolean {
    return this.listeners.size > 0;
  }

  /** Subscribe until the returned idempotent cleanup function is called. */
  subscribe(listener: FluxDiagnosticListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;

    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  /** Emit an observation to a stable snapshot of the current subscribers. */
  emit(event: FluxDiagnosticEvent): void {
    if (!this.active) return;

    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        console.error("[fluxfast] Error in diagnostic listener:", error);
      }
    }
  }

  /** Remove every subscriber without affecting any FluxFast runtime state. */
  removeAllListeners(): void {
    this.listeners.clear();
  }
}
