import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../src/live/protocol";
import {
  DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS,
  LiveManager,
  type LiveNetworkAdapter,
} from "../src/live/manager";
import type {
  LiveConnection,
  LiveConnectionOptions,
  LiveTransport,
} from "../src/live/transport";

afterEach(() => vi.useRealTimers());

class ControlledConnection implements LiveConnection {
  private readonly controller = new AbortController();
  private readonly queued: IteratorResult<LiveEvent>[] = [];
  private readonly waiting: Array<{
    resolve: (result: IteratorResult<LiveEvent>) => void;
    reject: (error: Error) => void;
  }> = [];
  private queuedError?: Error;
  public closeCount = 0;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  emit(event: LiveEvent): void {
    this.deliver({ done: false, value: event });
  }

  finish(): void {
    this.deliver({ done: true, value: undefined });
  }

  fail(error: Error): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.reject(error);
    else this.queuedError = error;
  }

  close(reason?: unknown): void {
    this.closeCount += 1;
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveEvent> {
    return {
      next: () => {
        if (this.queuedError) {
          const error = this.queuedError;
          this.queuedError = undefined;
          return Promise.reject(error);
        }
        const queued = this.queued.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise((resolve, reject) => {
          this.waiting.push({ resolve, reject });
        });
      },
    };
  }

  private deliver(result: IteratorResult<LiveEvent>): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(result);
    else this.queued.push(result);
  }
}

class ControlledTransport implements LiveTransport {
  public readonly connections: ControlledConnection[] = [];
  public readonly requests: LiveConnectionOptions[] = [];

  connect(options: LiveConnectionOptions): LiveConnection {
    this.requests.push(options);
    const connection = new ControlledConnection();
    this.connections.push(connection);
    return connection;
  }
}

class ControlledNetwork implements LiveNetworkAdapter {
  private online = true;
  private onOnline?: () => void;
  private onOffline?: () => void;
  public subscribed = false;

  isOnline(): boolean {
    return this.online;
  }

  subscribe(onOnline: () => void, onOffline: () => void): () => void {
    this.subscribed = true;
    this.onOnline = onOnline;
    this.onOffline = onOffline;
    return () => {
      this.subscribed = false;
      this.onOnline = undefined;
      this.onOffline = undefined;
    };
  }

  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    if (online) this.onOnline?.();
    else this.onOffline?.();
  }
}

const ready = (keys: string[]): LiveEvent => ({
  protocol: "fluxfast/1",
  type: "ready",
  keys,
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("LiveManager", () => {
  it("connects explicitly, reports ready status, and disconnects cleanly", async () => {
    const transport = new ControlledTransport();
    const events: LiveEvent[] = [];
    const statuses = vi.fn();
    const manager = new LiveManager({
      transport,
      clientId: "ff_tab",
      onEvent: event => events.push(event),
      now: () => 123,
    });
    manager.subscribe(statuses);
    manager.updateManifest("/dashboard", ["summary", "activity", "summary"]);

    expect(manager.getSnapshot().status).toBe("idle");
    expect(transport.requests).toHaveLength(0);
    manager.connect();
    manager.connect();

    expect(transport.requests).toEqual([
      expect.objectContaining({
        url: "/dashboard",
        keys: ["activity", "summary"],
        clientId: "ff_tab",
      }),
    ]);
    expect(manager.getSnapshot().status).toBe("connecting");

    transport.connections[0].emit(ready(["activity", "summary"]));
    await vi.waitFor(() => expect(manager.getSnapshot()).toEqual({
      status: "connected",
      connected: true,
      reconnectAttempt: 0,
      lastEventAt: 123,
    }));
    expect(events).toHaveLength(1);

    manager.disconnect();
    expect(transport.connections[0].closeCount).toBe(1);
    expect(manager.getSnapshot()).toMatchObject({
      status: "idle",
      connected: false,
      reconnectAttempt: 0,
    });
    expect(statuses).toHaveBeenCalled();
  });

  it("keeps one connection for an identical manifest and restarts changes", () => {
    const transport = new ControlledTransport();
    const manager = new LiveManager({ transport });
    expect(manager.clientId).toMatch(/^ff_[0-9a-f]{32}$/);
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();

    manager.updateManifest("/dashboard", ["summary", "summary"]);
    expect(transport.connections).toHaveLength(1);
    expect(transport.connections[0].closeCount).toBe(0);

    manager.updateManifest("/dashboard", ["activity", "summary"]);
    expect(transport.connections[0].closeCount).toBe(1);
    expect(transport.connections).toHaveLength(2);
    expect(transport.requests[1].keys).toEqual(["activity", "summary"]);

    manager.updateManifest("/reports", ["activity", "summary"]);
    expect(transport.connections[1].closeCount).toBe(1);
    expect(transport.connections).toHaveLength(3);
    expect(transport.requests.map(request => request.clientId)).toEqual([
      manager.clientId,
      manager.clientId,
      manager.clientId,
    ]);
  });

  it("rejects invalid configured client identities", () => {
    expect(() => new LiveManager({
      transport: new ControlledTransport(),
      clientId: "contains space",
    })).toThrowError(/client ID/);
  });

  it("rejects unsafe reconnect configuration", () => {
    expect(() => new LiveManager({ reconnectInitialDelayMs: 0 }))
      .toThrowError(/reconnectInitialDelayMs/);
    expect(() => new LiveManager({
      reconnectInitialDelayMs: 1_000,
      reconnectMaxDelayMs: 500,
    })).toThrowError(/reconnectMaxDelayMs/);
    expect(() => new LiveManager({ reconnectJitter: 1.1 }))
      .toThrowError(/reconnectJitter/);
  });

  it("disconnects and clears state when the manifest becomes empty", () => {
    const transport = new ControlledTransport();
    const manager = new LiveManager({ transport });
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();

    manager.updateManifest("/dashboard", []);

    expect(transport.connections[0].closeCount).toBe(1);
    expect(manager.getManifest()).toBeUndefined();
    expect(manager.getSnapshot()).toEqual({
      status: "idle",
      connected: false,
      reconnectAttempt: 0,
      lastEventAt: null,
    });
  });

  it("manually reconnects with an incremented attempt", async () => {
    const transport = new ControlledTransport();
    const manager = new LiveManager({ transport, now: () => 456 });
    const events: LiveEvent[] = [];
    manager.subscribeEvents(event => events.push(event));
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();
    transport.connections[0].emit(ready(["summary"]));
    await vi.waitFor(() => expect(manager.getSnapshot().connected).toBe(true));

    manager.reconnect();

    expect(transport.connections[0].closeCount).toBe(1);
    expect(manager.getSnapshot()).toMatchObject({
      status: "reconnecting",
      connected: false,
      reconnectAttempt: 1,
      lastEventAt: 456,
    });
    expect(transport.connections).toHaveLength(2);
    transport.connections[1].emit(ready(["summary"]));
    await vi.waitFor(() => expect(manager.getSnapshot().connected).toBe(true));
    expect(manager.getSnapshot().reconnectAttempt).toBe(0);
    expect(events.slice(-2)).toEqual([
      ready(["summary"]),
      {
        protocol: "fluxfast/1",
        type: "resync",
        keys: ["summary"],
        reason: "reconnect",
      },
    ]);
  });

  it("does not resync an old reconnect after a ready listener changes manifest", async () => {
    const transport = new ControlledTransport();
    const manager = new LiveManager({ transport });
    const events: LiveEvent[] = [];
    manager.subscribeEvents(event => {
      events.push(event);
      if (event.type === "ready" && transport.connections.length === 2) {
        manager.updateManifest("/reports", ["activity"]);
      }
    });
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();
    transport.connections[0].emit(ready(["summary"]));
    await flushMicrotasks();

    manager.reconnect();
    transport.connections[1].emit(ready(["summary"]));
    await flushMicrotasks();

    expect(transport.connections).toHaveLength(3);
    expect(transport.requests[2]).toMatchObject({
      url: "/reports",
      keys: ["activity"],
    });
    expect(events.filter(event => event.type === "resync")).toEqual([]);
    manager.destroy();
  });

  it("reconnects completion and failures with capped exponential backoff", async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    const errors: Error[] = [];
    const manager = new LiveManager({
      transport,
      onError: error => errors.push(error),
      reconnectJitter: 0,
      reconnectMaxDelayMs: 1_000,
    });
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();
    transport.connections[0].finish();
    await flushMicrotasks();
    expect(manager.getSnapshot()).toMatchObject({
      status: "reconnecting",
      reconnectAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connections).toHaveLength(2);

    const failure = new Error("stream failed");
    transport.connections[1].fail(failure);
    await flushMicrotasks();
    expect(manager.getSnapshot()).toMatchObject({
      status: "error",
      reconnectAttempt: 2,
    });
    expect(errors.at(-1)).toBe(failure);
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connections).toHaveLength(3);

    transport.connections[2].fail(new Error("still failing"));
    await flushMicrotasks();
    expect(manager.getSnapshot().reconnectAttempt).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.connections).toHaveLength(4);
    expect(DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS).toBe(10_000);
    manager.destroy();
  });

  it("pauses offline and retries immediately when the browser returns online", async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    const network = new ControlledNetwork();
    const events: LiveEvent[] = [];
    const manager = new LiveManager({ transport, network, reconnectJitter: 0 });
    manager.subscribeEvents(event => events.push(event));
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();
    transport.connections[0].emit(ready(["summary"]));
    await flushMicrotasks();

    network.setOnline(false);
    expect(transport.connections[0].closeCount).toBe(1);
    expect(manager.getSnapshot()).toMatchObject({
      status: "offline",
      connected: false,
      reconnectAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.connections).toHaveLength(1);

    network.setOnline(true);
    expect(transport.connections).toHaveLength(2);
    expect(manager.getSnapshot().status).toBe("reconnecting");
    transport.connections[1].emit(ready(["summary"]));
    await flushMicrotasks();
    expect(manager.getSnapshot()).toMatchObject({
      status: "connected",
      reconnectAttempt: 0,
    });
    expect(events.at(-1)).toMatchObject({
      type: "resync",
      reason: "reconnect",
      keys: ["summary"],
    });

    manager.disconnect();
    expect(network.subscribed).toBe(false);
  });

  it("honors lifecycle changes made by error callbacks", async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    let manager!: LiveManager;
    manager = new LiveManager({
      transport,
      reconnectJitter: 0,
      onError: () => manager.disconnect(),
    });
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();
    transport.connections[0].fail(new Error("stop live"));
    await flushMicrotasks();

    expect(manager.getSnapshot()).toMatchObject({
      status: "idle",
      connected: false,
      reconnectAttempt: 0,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.connections).toHaveLength(1);
  });

  it("does not open a connection after a status listener disconnects", () => {
    const transport = new ControlledTransport();
    const manager = new LiveManager({ transport });
    manager.updateManifest("/dashboard", ["summary"]);
    manager.subscribe(() => {
      if (manager.getSnapshot().status === "connecting") {
        manager.disconnect();
      }
    });

    manager.connect();

    expect(transport.connections).toHaveLength(0);
    expect(manager.getSnapshot().status).toBe("idle");
  });

  it("isolates event callback errors and destroys subscriptions", async () => {
    const transport = new ControlledTransport();
    const diagnostic = new Error("diagnostic failed");
    const errors: Error[] = [];
    const subscriber = vi.fn();
    const manager = new LiveManager({
      transport,
      onEvent: () => { throw diagnostic; },
      onError: error => errors.push(error),
    });
    manager.subscribe(subscriber);
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();
    transport.connections[0].emit(ready(["summary"]));

    await vi.waitFor(() => expect(errors).toEqual([diagnostic]));
    expect(manager.getSnapshot().status).toBe("connected");
    manager.destroy();
    expect(transport.connections[0].closeCount).toBe(1);
    const calls = subscriber.mock.calls.length;
    manager.updateManifest("/other", ["summary"]);
    expect(subscriber).toHaveBeenCalledTimes(calls);
  });
});
