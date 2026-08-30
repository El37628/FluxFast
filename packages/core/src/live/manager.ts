/** Framework-neutral lifecycle manager for one logical Live Resource connection. */

import type { LiveEvent } from "./protocol";
import {
  createFetchSseLiveTransport,
  type LiveConnection,
  type LiveTransport,
  serializeLiveKeys,
} from "./transport";

export type LiveConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

export interface LiveStatusSnapshot {
  readonly status: LiveConnectionStatus;
  readonly connected: boolean;
  readonly reconnectAttempt: number;
  readonly lastEventAt: number | null;
}

export interface LiveManifest {
  readonly url: string;
  readonly keys: readonly string[];
}

export interface LiveManagerOptions {
  transport?: LiveTransport;
  clientId?: string;
  headers?: Record<string, string>;
  onEvent?: (event: LiveEvent) => void;
  onError?: (error: Error) => void;
  now?: () => number;
}

const INITIAL_STATUS: LiveStatusSnapshot = Object.freeze({
  status: "idle",
  connected: false,
  reconnectAttempt: 0,
  lastEventAt: null,
});

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class LiveManager {
  public readonly transport: LiveTransport;

  private readonly clientId?: string;
  private readonly headers?: Record<string, string>;
  private readonly onEvent?: (event: LiveEvent) => void;
  private readonly onError?: (error: Error) => void;
  private readonly now: () => number;
  private readonly subscribers = new Set<() => void>();
  private readonly eventSubscribers = new Set<(event: LiveEvent) => void>();
  private snapshot: LiveStatusSnapshot = INITIAL_STATUS;
  private manifest?: LiveManifest;
  private identity?: string;
  private connection?: LiveConnection;
  private generation = 0;
  private desired = false;

  constructor(options: LiveManagerOptions = {}) {
    this.transport = options.transport ?? createFetchSseLiveTransport();
    this.clientId = options.clientId;
    this.headers = options.headers ? { ...options.headers } : undefined;
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): LiveStatusSnapshot {
    return this.snapshot;
  }

  getManifest(): LiveManifest | undefined {
    return this.manifest;
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  subscribeEvents(listener: (event: LiveEvent) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => this.eventSubscribers.delete(listener);
  }

  /** Replace the authoritative page URL and live-key manifest. */
  updateManifest(url: string, keys: string[]): void {
    const nextManifest = this.normalizeManifest(url, keys);
    const nextIdentity = nextManifest
      ? JSON.stringify([nextManifest.url, nextManifest.keys])
      : undefined;
    if (nextIdentity === this.identity) return;

    const shouldReconnect = this.desired;
    this.stopConnection();
    this.manifest = nextManifest;
    this.identity = nextIdentity;
    this.setSnapshot(INITIAL_STATUS);
    if (shouldReconnect && nextManifest) {
      this.startConnection("connecting", 0);
    }
  }

  /** Connect the current manifest. Repeated calls are idempotent. */
  connect(): void {
    this.desired = true;
    if (!this.manifest || this.connection) return;
    this.startConnection("connecting", 0);
  }

  /** Stop the active stream while retaining the current manifest. */
  disconnect(): void {
    this.desired = false;
    this.stopConnection();
    this.setSnapshot({
      ...this.snapshot,
      status: "idle",
      connected: false,
      reconnectAttempt: 0,
    });
  }

  /** Replace the active stream immediately and retain its manifest. */
  reconnect(): void {
    this.desired = true;
    if (!this.manifest) {
      this.setSnapshot(INITIAL_STATUS);
      return;
    }
    const reconnectAttempt = this.snapshot.reconnectAttempt + 1;
    this.stopConnection();
    this.startConnection("reconnecting", reconnectAttempt);
  }

  /** Disconnect and forget all page/authentication state. */
  clear(): void {
    this.desired = false;
    this.stopConnection();
    this.manifest = undefined;
    this.identity = undefined;
    this.setSnapshot(INITIAL_STATUS);
  }

  destroy(): void {
    this.clear();
    this.subscribers.clear();
    this.eventSubscribers.clear();
  }

  private normalizeManifest(url: string, keys: string[]): LiveManifest | undefined {
    if (keys.length === 0) return undefined;
    if (typeof url !== "string" || url.length === 0) {
      throw new TypeError("A live manifest requires a non-empty page URL");
    }
    const normalizedKeys = serializeLiveKeys(keys).split(",");
    return Object.freeze({
      url,
      keys: Object.freeze(normalizedKeys),
    });
  }

  private startConnection(
    status: "connecting" | "reconnecting",
    reconnectAttempt: number
  ): void {
    if (!this.manifest) return;
    const generation = ++this.generation;
    this.setSnapshot({
      ...this.snapshot,
      status,
      connected: false,
      reconnectAttempt,
    });

    let connection: LiveConnection;
    try {
      connection = this.transport.connect({
        url: this.manifest.url,
        keys: [...this.manifest.keys],
        clientId: this.clientId,
        headers: this.headers,
      });
    } catch (error) {
      this.handleConnectionError(generation, error);
      return;
    }
    this.connection = connection;
    void this.consume(connection, generation);
  }

  private async consume(connection: LiveConnection, generation: number): Promise<void> {
    try {
      for await (const event of connection) {
        if (generation !== this.generation) return;
        this.setSnapshot({
          ...this.snapshot,
          status: event.type === "ready" ? "connected" : this.snapshot.status,
          connected: event.type === "ready" ? true : this.snapshot.connected,
          lastEventAt: this.now(),
        });
        this.emitEvent(event);
      }
      if (generation !== this.generation) return;
      this.connection = undefined;
      this.setSnapshot({
        ...this.snapshot,
        status: "idle",
        connected: false,
      });
    } catch (error) {
      this.handleConnectionError(generation, error);
    }
  }

  private handleConnectionError(generation: number, error: unknown): void {
    if (generation !== this.generation) return;
    this.connection = undefined;
    const normalized = normalizeError(error);
    this.setSnapshot({
      ...this.snapshot,
      status: "error",
      connected: false,
    });
    this.reportError(normalized);
  }

  private reportError(error: Error): void {
    try {
      this.onError?.(error);
    } catch {
      // Application diagnostics must never destabilize live synchronization.
    }
  }

  private emitEvent(event: LiveEvent): void {
    const listeners = [
      ...(this.onEvent ? [this.onEvent] : []),
      ...this.eventSubscribers,
    ];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        this.reportError(normalizeError(error));
      }
    }
  }

  private stopConnection(): void {
    ++this.generation;
    const connection = this.connection;
    this.connection = undefined;
    connection?.close("live lifecycle changed");
  }

  private setSnapshot(next: LiveStatusSnapshot): void {
    if (
      next.status === this.snapshot.status &&
      next.connected === this.snapshot.connected &&
      next.reconnectAttempt === this.snapshot.reconnectAttempt &&
      next.lastEventAt === this.snapshot.lastEventAt
    ) {
      return;
    }
    this.snapshot = Object.freeze({ ...next });
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber();
      } catch (error) {
        this.reportError(normalizeError(error));
      }
    }
  }
}

export function createLiveManager(options: LiveManagerOptions = {}): LiveManager {
  return new LiveManager(options);
}
