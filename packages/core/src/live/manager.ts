/** Framework-neutral lifecycle manager for one logical Live Resource connection. */

import type { LiveEvent } from "./protocol";
import { assertClientId, createClientId } from "./client-id";
import { PROTOCOL_VERSION } from "../protocol";
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

export interface LiveNetworkAdapter {
  isOnline(): boolean;
  subscribe(onOnline: () => void, onOffline: () => void): () => void;
}

export interface LiveManagerOptions {
  transport?: LiveTransport;
  clientId?: string;
  headers?: Record<string, string>;
  onEvent?: (event: LiveEvent) => void;
  onError?: (error: Error) => void;
  now?: () => number;
  network?: LiveNetworkAdapter;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitter?: number;
  random?: () => number;
}

export const DEFAULT_LIVE_RECONNECT_INITIAL_DELAY_MS = 500;
export const DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS = 10_000;
export const DEFAULT_LIVE_RECONNECT_JITTER = 0.2;

const INITIAL_STATUS: LiveStatusSnapshot = Object.freeze({
  status: "idle",
  connected: false,
  reconnectAttempt: 0,
  lastEventAt: null,
});

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createBrowserNetworkAdapter(): LiveNetworkAdapter {
  return {
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    subscribe: (onOnline, onOffline) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
      return () => {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      };
    },
  };
}

function assertReconnectOptions(
  initialDelay: number,
  maxDelay: number,
  jitter: number
): void {
  if (!Number.isFinite(initialDelay) || initialDelay <= 0) {
    throw new RangeError("reconnectInitialDelayMs must be a finite positive number");
  }
  if (!Number.isFinite(maxDelay) || maxDelay < initialDelay) {
    throw new RangeError(
      "reconnectMaxDelayMs must be finite and at least reconnectInitialDelayMs"
    );
  }
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new RangeError("reconnectJitter must be between 0 and 1");
  }
}

export class LiveManager {
  public readonly transport: LiveTransport;
  public readonly clientId: string;

  private readonly headers?: Record<string, string>;
  private readonly onEvent?: (event: LiveEvent) => void;
  private readonly onError?: (error: Error) => void;
  private readonly now: () => number;
  private readonly network: LiveNetworkAdapter;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectJitter: number;
  private readonly random: () => number;
  private readonly subscribers = new Set<() => void>();
  private readonly eventSubscribers = new Set<(event: LiveEvent) => void>();
  private snapshot: LiveStatusSnapshot = INITIAL_STATUS;
  private manifest?: LiveManifest;
  private identity?: string;
  private connection?: LiveConnection;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopNetworkSubscription?: () => void;
  private generation = 0;
  private desired = false;

  constructor(options: LiveManagerOptions = {}) {
    this.transport = options.transport ?? createFetchSseLiveTransport();
    assertClientId(options.clientId);
    this.clientId = options.clientId ?? createClientId();
    this.headers = options.headers ? { ...options.headers } : undefined;
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.network = options.network ?? createBrowserNetworkAdapter();
    this.reconnectInitialDelayMs =
      options.reconnectInitialDelayMs ?? DEFAULT_LIVE_RECONNECT_INITIAL_DELAY_MS;
    this.reconnectMaxDelayMs =
      options.reconnectMaxDelayMs ?? DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS;
    this.reconnectJitter =
      options.reconnectJitter ?? DEFAULT_LIVE_RECONNECT_JITTER;
    this.random = options.random ?? Math.random;
    assertReconnectOptions(
      this.reconnectInitialDelayMs,
      this.reconnectMaxDelayMs,
      this.reconnectJitter
    );
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
    this.cancelReconnect();
    this.stopConnection();
    this.manifest = nextManifest;
    this.identity = nextIdentity;
    this.setSnapshot(INITIAL_STATUS);
    if (shouldReconnect && nextManifest) {
      this.ensureNetworkSubscription();
      if (this.network.isOnline()) {
        this.startConnection("connecting", 0);
      } else {
        this.setOffline(1);
      }
    } else if (!nextManifest) {
      this.stopNetworkSubscription?.();
      this.stopNetworkSubscription = undefined;
    }
  }

  /** Connect the current manifest. Repeated calls are idempotent. */
  connect(): void {
    this.desired = true;
    if (!this.manifest || this.connection || this.reconnectTimer !== undefined) return;
    this.ensureNetworkSubscription();
    if (!this.network.isOnline()) {
      this.setOffline(1);
      return;
    }
    this.startConnection("connecting", 0);
  }

  /** Stop the active stream while retaining the current manifest. */
  disconnect(): void {
    this.desired = false;
    this.cancelReconnect();
    this.stopConnection();
    this.stopNetworkSubscription?.();
    this.stopNetworkSubscription = undefined;
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
    this.ensureNetworkSubscription();
    const reconnectAttempt = this.snapshot.reconnectAttempt + 1;
    this.cancelReconnect();
    this.stopConnection();
    if (!this.network.isOnline()) {
      this.setOffline(Math.max(1, reconnectAttempt));
      return;
    }
    this.startConnection("reconnecting", reconnectAttempt);
  }

  /** Disconnect and forget all page/authentication state. */
  clear(): void {
    this.desired = false;
    this.cancelReconnect();
    this.stopConnection();
    this.stopNetworkSubscription?.();
    this.stopNetworkSubscription = undefined;
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
    if (!this.manifest || !this.desired || this.connection) return;
    const manifest = this.manifest;
    const generation = ++this.generation;
    this.setSnapshot({
      ...this.snapshot,
      status,
      connected: false,
      reconnectAttempt,
    });
    if (
      generation !== this.generation ||
      !this.desired ||
      this.manifest !== manifest ||
      this.connection
    ) {
      return;
    }

    let connection: LiveConnection;
    try {
      connection = this.transport.connect({
        url: manifest.url,
        keys: [...manifest.keys],
        clientId: this.clientId,
        headers: this.headers,
      });
    } catch (error) {
      this.handleConnectionError(generation, error);
      return;
    }
    if (
      generation !== this.generation ||
      !this.desired ||
      this.manifest !== manifest
    ) {
      connection.close("live lifecycle changed during connection setup");
      return;
    }
    this.connection = connection;
    void this.consume(connection, generation, reconnectAttempt);
  }

  private async consume(
    connection: LiveConnection,
    generation: number,
    reconnectAttempt: number
  ): Promise<void> {
    try {
      for await (const event of connection) {
        if (generation !== this.generation) return;
        const reconnected = event.type === "ready" && reconnectAttempt > 0;
        const reconnectManifest = reconnected ? this.manifest : undefined;
        this.setSnapshot({
          ...this.snapshot,
          status: event.type === "ready" ? "connected" : this.snapshot.status,
          connected: event.type === "ready" ? true : this.snapshot.connected,
          reconnectAttempt: event.type === "ready" ? 0 : this.snapshot.reconnectAttempt,
          lastEventAt: this.now(),
        });
        if (generation !== this.generation) return;
        this.emitEvent(event);
        if (generation !== this.generation) return;
        if (
          reconnectManifest &&
          generation === this.generation &&
          this.manifest === reconnectManifest
        ) {
          this.emitEvent({
            protocol: PROTOCOL_VERSION,
            type: "resync",
            keys: [...reconnectManifest.keys],
            reason: "reconnect",
          });
        }
      }
      if (generation !== this.generation) return;
      this.connection = undefined;
      if (this.desired) {
        this.scheduleReconnect(false);
      } else {
        this.setSnapshot({
          ...this.snapshot,
          status: "idle",
          connected: false,
        });
      }
    } catch (error) {
      this.handleConnectionError(generation, error);
    }
  }

  private handleConnectionError(generation: number, error: unknown): void {
    if (generation !== this.generation) return;
    this.connection = undefined;
    const normalized = normalizeError(error);
    this.reportError(normalized);
    if (generation !== this.generation) return;
    if (this.desired) {
      this.scheduleReconnect(true);
    } else {
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        connected: false,
      });
    }
  }

  private scheduleReconnect(errorState: boolean): void {
    this.cancelReconnect();
    if (!this.desired || !this.manifest) return;

    const reconnectAttempt = Math.max(1, this.snapshot.reconnectAttempt + 1);
    if (!this.network.isOnline()) {
      this.setOffline(reconnectAttempt);
      return;
    }

    this.setSnapshot({
      ...this.snapshot,
      status: errorState ? "error" : "reconnecting",
      connected: false,
      reconnectAttempt,
    });
    if (!this.desired || !this.manifest || this.connection) return;
    const delay = this.reconnectDelay(reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.desired || !this.manifest || this.connection) return;
      if (!this.network.isOnline()) {
        this.setOffline(reconnectAttempt);
        return;
      }
      this.startConnection("reconnecting", reconnectAttempt);
    }, delay);
  }

  private reconnectDelay(attempt: number): number {
    const exponent = Math.min(Math.max(0, attempt - 1), 30);
    const base = Math.min(
      this.reconnectInitialDelayMs * 2 ** exponent,
      this.reconnectMaxDelayMs
    );
    const sample = this.random();
    const normalizedSample = Number.isFinite(sample)
      ? Math.min(1, Math.max(0, sample))
      : 0.5;
    const jitterFactor = 1 + this.reconnectJitter * (2 * normalizedSample - 1);
    return Math.min(
      this.reconnectMaxDelayMs,
      Math.max(0, Math.round(base * jitterFactor))
    );
  }

  private setOffline(reconnectAttempt: number): void {
    this.cancelReconnect();
    this.setSnapshot({
      ...this.snapshot,
      status: "offline",
      connected: false,
      reconnectAttempt,
    });
  }

  private ensureNetworkSubscription(): void {
    if (this.stopNetworkSubscription) return;
    this.stopNetworkSubscription = this.network.subscribe(
      this.handleOnline,
      this.handleOffline
    );
  }

  private readonly handleOnline = (): void => {
    if (!this.desired || !this.manifest || this.connection) return;
    const reconnectAttempt = Math.max(1, this.snapshot.reconnectAttempt);
    this.cancelReconnect();
    this.startConnection("reconnecting", reconnectAttempt);
  };

  private readonly handleOffline = (): void => {
    if (!this.desired || !this.manifest) return;
    const reconnectAttempt =
      this.snapshot.status === "offline"
        ? Math.max(1, this.snapshot.reconnectAttempt)
        : Math.max(1, this.snapshot.reconnectAttempt + 1);
    this.cancelReconnect();
    this.stopConnection();
    this.setOffline(reconnectAttempt);
  };

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
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
