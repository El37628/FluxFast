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

const MAX_BOOTSTRAP_EVENTS = 32;

/**
 * Fan-out channel for optional development diagnostics.
 *
 * The hub deliberately stores no timeline. Consumers such as DevTools own any
 * bounded history, while runtime hot paths can use `active` to avoid allocating
 * diagnostic events when nobody is observing them.
 */
export class FluxDiagnosticsHub {
  private readonly listeners = new Set<FluxDiagnosticListener>();
  private bootstrapEvents: readonly FluxDiagnosticEvent[] = [];

  /** Whether at least one diagnostic consumer is currently subscribed. */
  get active(): boolean {
    return this.listeners.size > 0;
  }

  /** Subscribe until the returned idempotent cleanup function is called. */
  subscribe(listener: FluxDiagnosticListener): () => void {
    this.listeners.add(listener);
    if (this.bootstrapEvents.length > 0) {
      const events = this.bootstrapEvents;
      this.bootstrapEvents = [];
      for (const event of events) this.notify(listener, event);
    }
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
      this.notify(listener, event);
    }
  }

  /**
   * Publish a bounded, one-shot batch captured before a browser subscriber
   * could exist, such as an initial SSR trace.
   */
  bootstrap(events: readonly FluxDiagnosticEvent[]): void {
    const bounded = events.slice(0, MAX_BOOTSTRAP_EVENTS);
    if (this.active) {
      for (const event of bounded) this.emit(event);
      return;
    }
    this.bootstrapEvents = bounded;
  }

  /** Remove every subscriber without affecting any FluxFast runtime state. */
  removeAllListeners(): void {
    this.listeners.clear();
    this.bootstrapEvents = [];
  }

  private notify(
    listener: FluxDiagnosticListener,
    event: FluxDiagnosticEvent
  ): void {
    try {
      listener(event);
    } catch (error) {
      console.error("[fluxfast] Error in diagnostic listener:", error);
    }
  }
}
