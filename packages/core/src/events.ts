/**
 * Framework-neutral event emitter for FluxFast runtime events.
 */

import type { ResourceErrorDetail } from "./protocol";

export type ResourceLoadReason = "deferred" | "refresh" | "mutation" | "retry";

export interface ResourceLoadEvent {
  url: string;
  keys: string[];
  reason: ResourceLoadReason;
}

export interface ResourceLoadErrorEvent extends ResourceLoadEvent {
  error: Error;
}

export interface ResourceErrorEvent extends ResourceLoadEvent {
  key: string;
  error: ResourceErrorDetail;
}

export type FluxEventName =
  | "visit:start"
  | "visit:success"
  | "visit:error"
  | "visit:cancel"
  | "resource:load:start"
  | "resource:load:success"
  | "resource:load:error"
  | "resource:error"
  | "resource:update"
  | "resource:invalidate"
  | "cache:hit"
  | "cache:miss"
  | "prefetch:start"
  | "prefetch:success"
  | "mutation:start"
  | "mutation:success"
  | "mutation:error";

export interface FluxEventPayloads {
  "visit:start": { visitId: string; url: string };
  "visit:success": { visitId: string; url: string; component: string };
  "visit:error": { visitId: string; url: string; error: Error };
  "visit:cancel": { visitId: string; url: string };
  "resource:load:start": ResourceLoadEvent;
  "resource:load:success": ResourceLoadEvent;
  "resource:load:error": ResourceLoadErrorEvent;
  "resource:error": ResourceErrorEvent;
  "resource:update": { key: string; version: string };
  "resource:invalidate": { key: string };
  "cache:hit": { key: string };
  "cache:miss": { key: string };
  "prefetch:start": { url: string };
  "prefetch:success": { url: string };
  "mutation:start": { url: string };
  "mutation:success": { url: string };
  "mutation:error": { url: string; error: Error };
}

export type FluxEventListener<E extends FluxEventName> = (
  payload: FluxEventPayloads[E]
) => void;

export class EventEmitter {
  private listeners: Map<string, Set<FluxEventListener<any>>> = new Map();

  on<E extends FluxEventName>(
    event: E,
    listener: FluxEventListener<E>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);

    return () => {
      this.off(event, listener);
    };
  }

  off<E extends FluxEventName>(
    event: E,
    listener: FluxEventListener<E>
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  emit<E extends FluxEventName>(
    event: E,
    payload: FluxEventPayloads[E]
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of Array.from(set)) {
        try {
          listener(payload);
        } catch (e) {
          console.error(`[fluxfast] Error in listener for event ${event}:`, e);
        }
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
