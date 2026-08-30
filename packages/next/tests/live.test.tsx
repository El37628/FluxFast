// @vitest-environment happy-dom

import React, { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  FluxRouter,
  LiveManager,
  type LiveConnection,
  type LiveConnectionOptions,
  type LiveEvent,
  type LiveTransport,
} from "@fluxfast/core";
import {
  useDeferredResource,
  useResource,
  useResourceState,
} from "../src/hooks";
import { useLiveStatus } from "../src/live";
import { FluxProvider } from "../src/provider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class ControlledConnection implements LiveConnection {
  private readonly controller = new AbortController();
  private readonly events: LiveEvent[] = [];
  private waiter?: (result: IteratorResult<LiveEvent>) => void;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  emit(event: LiveEvent): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: event });
      return;
    }
    this.events.push(event);
  }

  close(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveEvent> {
    return {
      next: () => {
        const event = this.events.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.signal.aborted) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise(resolve => { this.waiter = resolve; });
      },
    };
  }
}

class ControlledLiveTransport implements LiveTransport {
  readonly requests: LiveConnectionOptions[] = [];
  readonly connections: ControlledConnection[] = [];

  connect(options: LiveConnectionOptions): LiveConnection {
    this.requests.push(options);
    const connection = new ControlledConnection();
    this.connections.push(connection);
    return connection;
  }
}

const roots = new Set<Root>();

async function mount(element: React.ReactNode): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => root.render(element));
  return { container, root };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
  roots.delete(root);
}

async function flushLiveEvent(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function createLiveRouter(liveTransport: LiveTransport): FluxRouter {
  return new FluxRouter({
    deferHistory: true,
    liveBatchDelayMs: 1_000,
    liveManager: new LiveManager({
      transport: liveTransport,
      clientId: "ff_next_adapter_test",
    }),
    initialEnvelope: {
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resourceKeys: ["summary", "activity"],
      resources: {
        summary: { version: "s1", value: { count: 1 } },
        activity: { version: "a1", value: ["created"] },
      },
      live: ["summary", "activity"],
    },
  });
}

afterEach(async () => {
  for (const root of [...roots]) await unmount(root);
  document.body.replaceChildren();
});

describe("Next live integration", () => {
  it("does not open a stream during SSR and renders an idle server status", () => {
    const liveTransport = new ControlledLiveTransport();
    const router = createLiveRouter(liveTransport);

    function Status() {
      return <span>{useLiveStatus().status}</span>;
    }

    const html = renderToString(
      <FluxProvider router={router}>
        <Status />
      </FluxProvider>
    );

    expect(html).toContain("idle");
    expect(liveTransport.connections).toHaveLength(0);
    router.destroy();
  });

  it("starts after hydration and closes the stream during provider cleanup", async () => {
    const liveTransport = new ControlledLiveTransport();
    const router = createLiveRouter(liveTransport);
    const { root } = await mount(
      <FluxProvider router={router}>
        <span>hydrated</span>
      </FluxProvider>
    );

    expect(liveTransport.requests).toHaveLength(1);
    expect(liveTransport.connections[0].signal.aborted).toBe(false);

    await unmount(root);
    expect(liveTransport.connections[0].signal.aborted).toBe(true);
    router.destroy();
  });

  it("keeps exactly one active logical stream under StrictMode", async () => {
    const liveTransport = new ControlledLiveTransport();
    const router = createLiveRouter(liveTransport);
    const { root } = await mount(
      <StrictMode>
        <FluxProvider router={router}>
          <span>strict</span>
        </FluxProvider>
      </StrictMode>
    );

    expect(liveTransport.connections.length).toBeGreaterThanOrEqual(1);
    expect(liveTransport.connections.filter(connection => !connection.signal.aborted))
      .toHaveLength(1);

    await unmount(root);
    expect(liveTransport.connections.every(connection => connection.signal.aborted))
      .toBe(true);
    router.destroy();
  });

  it("updates useLiveStatus as the connection becomes ready and clears on logout", async () => {
    const liveTransport = new ControlledLiveTransport();
    const router = createLiveRouter(liveTransport);

    function Status() {
      const live = useLiveStatus();
      return <span>{`${live.status}:${String(live.connected)}`}</span>;
    }

    const { container, root } = await mount(
      <FluxProvider router={router}>
        <Status />
      </FluxProvider>
    );
    expect(container.textContent).toBe("connecting:false");

    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "ready",
      keys: ["activity", "summary"],
    });
    await flushLiveEvent();
    expect(container.textContent).toBe("connected:true");

    await act(async () => router.clear());
    expect(container.textContent).toBe("idle:false");
    expect(liveTransport.connections[0].signal.aborted).toBe(true);
    await unmount(root);
    router.destroy();
  });

  it("re-renders existing resource hooks after an immediate live patch", async () => {
    const liveTransport = new ControlledLiveTransport();
    const router = createLiveRouter(liveTransport);

    function Resources() {
      const summary = useResource<{ count: number }>("summary");
      const summaryState = useResourceState<{ count: number }>("summary");
      const activity = useDeferredResource<string[]>("activity");
      return (
        <span>{`${summary.count}:${String(summaryState.stale)}:${activity.data?.join(",")}:${String(activity.stale)}`}</span>
      );
    }

    const { container, root } = await mount(
      <FluxProvider router={router}>
        <Resources />
      </FluxProvider>
    );
    expect(container.textContent).toBe("1:false:created:false");

    liveTransport.connections[0].emit({
      protocol: "fluxfast/1",
      type: "patch",
      patches: {
        summary: [{ op: "replace-resource", value: { count: 2 } }],
        activity: [{ op: "append-item", value: "updated" }],
      },
    });
    await flushLiveEvent();

    expect(container.textContent).toBe("2:true:created,updated:true");
    await unmount(root);
    router.destroy();
  });

  it("does not open a stream for an old envelope without a live manifest", async () => {
    const liveTransport = new ControlledLiveTransport();
    const router = new FluxRouter({
      deferHistory: true,
      liveManager: new LiveManager({
        transport: liveTransport,
        clientId: "ff_next_adapter_test",
      }),
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: { summary: { version: "s1", value: { count: 1 } } },
      },
    });

    const { root } = await mount(
      <FluxProvider router={router}>
        <span>legacy</span>
      </FluxProvider>
    );
    expect(liveTransport.connections).toHaveLength(0);
    await unmount(root);
    router.destroy();
  });
});
