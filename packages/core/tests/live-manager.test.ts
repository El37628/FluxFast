import { describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../src/live/protocol";
import { LiveManager } from "../src/live/manager";
import type {
  LiveConnection,
  LiveConnectionOptions,
  LiveTransport,
} from "../src/live/transport";

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

const ready = (keys: string[]): LiveEvent => ({
  protocol: "fluxfast/1",
  type: "ready",
  keys,
});

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
  });

  it("moves natural completion to idle and transport failures to error", async () => {
    const transport = new ControlledTransport();
    const errors: Error[] = [];
    const manager = new LiveManager({ transport, onError: error => errors.push(error) });
    manager.updateManifest("/dashboard", ["summary"]);
    manager.connect();
    transport.connections[0].finish();
    await vi.waitFor(() => expect(manager.getSnapshot().status).toBe("idle"));

    manager.connect();
    const failure = new Error("stream failed");
    transport.connections[1].fail(failure);

    await vi.waitFor(() => expect(manager.getSnapshot().status).toBe("error"));
    expect(errors.at(-1)).toBe(failure);
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
