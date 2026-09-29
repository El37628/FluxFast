// @vitest-environment happy-dom

import React, { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FluxRouter } from "@fluxfast/core";
import { FluxProvider } from "@fluxfast/next";
import { FluxDevtools } from "../src";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mounted = new Set<{ root: Root; router: FluxRouter }>();

async function mountDevtools(
  element: React.ReactNode,
  router: FluxRouter
): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.add({ root, router });
  await act(async () => root.render(element));
}

afterEach(async () => {
  for (const entry of mounted) {
    await act(async () => entry.root.unmount());
    entry.router.destroy();
  }
  mounted.clear();
  document.body.replaceChildren();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("FluxDevtools", () => {
  it("mounts one isolated Debugbar and releases every subscription", async () => {
    const router = new FluxRouter({
      deferHistory: true,
      initialPage: { component: "rooms/index", url: "/rooms?secret=query-secret-42" },
    });
    router.resourceStore.set({
      key: "rooms",
      version: "rooms-v2",
      value: { secret: "resource-value-secret-42" },
    });

    await mountDevtools(
      <StrictMode>
        <FluxProvider router={router}>
          <FluxDevtools />
        </FluxProvider>
      </StrictMode>,
      router
    );

    const hosts = document.querySelectorAll("[data-fluxfast-devtools-host]");
    expect(hosts).toHaveLength(1);
    expect(router.diagnostics.active).toBe(true);
    const shadow = hosts[0].shadowRoot!;
    const button = shadow.querySelector("button")!;
    await act(async () => {
      router.diagnostics.emit({
        id: "server-trace-1",
        timestamp: Date.now(),
        type: "server-trace",
        correlationId: "visit-1",
        data: {
          type: "page",
          durationMs: 12.4,
          pageMs: 2,
          resourcesMs: 8,
          serializeMs: 2.4,
          resources: [{
            key: "rooms",
            result: "cache-hit",
            durationMs: 2.2,
            scope: "tenant",
            ttl: 30_000,
            deferred: false,
            live: true,
            cacheBackend: "redis",
            cacheResult: "hit",
            cacheMs: 1.1,
            loaderMs: 0,
          }],
        },
      });
    });
    expect(button.textContent).toContain("FluxFast");
    expect(button.textContent).toContain("/rooms");
    expect(button.textContent).toContain("1 Resources");
    expect(button.textContent).toContain("H1 M0");
    expect(button.textContent).toContain("Live 1");
    expect(button.textContent).toContain("12 ms");
    expect(shadow.textContent).not.toContain("query-secret-42");
    expect(shadow.textContent).not.toContain("resource-value-secret-42");
    expect(shadow.querySelector(".ff-panel")).toBeNull();

    await act(async () => button.click());

    expect(shadow.querySelector(".ff-panel")).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(shadow.textContent).toContain("rooms/index");
    expect(shadow.textContent).toContain("Cache hits");
    expect(shadow.textContent).toContain("Client session");

    const resourcesTab = shadow.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="fluxfast-panel-resources"]'
    )!;
    await act(async () => resourcesTab.click());

    expect(resourcesTab.getAttribute("aria-selected")).toBe("true");
    expect(shadow.querySelector("table")?.textContent).toContain("Resource");
    expect(shadow.querySelector("table")?.textContent).toContain("rooms");
    expect(shadow.querySelector("table")?.textContent).toContain("cache");

    const inspect = shadow.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect rooms"]'
    )!;
    await act(async () => inspect.click());
    const details = shadow.querySelector(".ff-resource-detail")!;
    expect(details.textContent).toContain("Server result");
    expect(details.textContent).toContain("cache-hit");
    expect(details.textContent).toContain("tenant");
    expect(details.textContent).not.toContain("resource-value-secret-42");

    const timelineTab = shadow.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="fluxfast-panel-timeline"]'
    )!;
    await act(async () => timelineTab.click());
    expect(timelineTab.getAttribute("aria-selected")).toBe("true");
    expect(shadow.querySelectorAll(".ff-timeline-row").length).toBeGreaterThanOrEqual(2);
    expect(shadow.textContent).toContain("SERVER");
    expect(shadow.textContent).toContain("RESOURCE rooms");

    const resourceFilter = [...shadow.querySelectorAll<HTMLButtonElement>(
      ".ff-filter"
    )].find(candidate => candidate.textContent === "resource")!;
    await act(async () => resourceFilter.click());
    expect(resourceFilter.getAttribute("aria-pressed")).toBe("true");
    expect(shadow.querySelectorAll(".ff-timeline-row")).toHaveLength(1);

    const timelineRow = shadow.querySelector<HTMLButtonElement>(
      ".ff-timeline-row"
    )!;
    await act(async () => timelineRow.click());
    expect(shadow.textContent).toContain("Correlation: visit-1");
    expect(shadow.querySelector(".ff-waterfall")?.textContent).toContain(
      "Page handler"
    );

    const search = shadow.querySelector<HTMLInputElement>(
      '.ff-search-label input[type="search"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(search, "does-not-exist");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(shadow.textContent).toContain("No events match the current filters.");

    const clear = [...shadow.querySelectorAll<HTMLButtonElement>(
      ".ff-secondary-button"
    )].find(candidate => candidate.textContent === "Clear")!;
    await act(async () => clear.click());
    expect(shadow.textContent).toContain("No diagnostic events recorded yet.");

    const entry = [...mounted][0];
    await act(async () => entry.root.unmount());
    mounted.delete(entry);
    expect(document.querySelectorAll("[data-fluxfast-devtools-host]")).toHaveLength(0);
    expect(router.diagnostics.active).toBe(false);
    router.destroy();
  });

  it("separates cache layers and exposes value-free mutation details", async () => {
    const router = new FluxRouter({ deferHistory: true });
    await mountDevtools(
      <FluxProvider router={router}>
        <FluxDevtools defaultOpen />
      </FluxProvider>,
      router
    );

    await act(async () => {
      const emit = (
        id: string,
        type: Parameters<typeof router.diagnostics.emit>[0]["type"],
        data: unknown,
        correlationId: string
      ) => router.diagnostics.emit({
        id,
        type,
        data,
        correlationId,
        timestamp: Date.now(),
      });
      emit("page-cache", "page-cache", {
        action: "miss",
        source: "navigation",
        url: "/rooms?cache-secret=hidden",
      }, "visit-cache");
      emit("page-transport", "transport", {
        phase: "start",
        requestType: "page",
        method: "GET",
        path: "/rooms?transport-secret=hidden",
      }, "visit-cache");
      emit("page-trace", "server-trace", {
        type: "page",
        durationMs: 13,
        truncated: false,
        resources: [{
          key: "rooms",
          result: "cache-hit",
          cacheResult: "hit",
          cacheBackend: "redis",
          durationMs: 2.4,
          cacheMs: 1.2,
          loaderMs: 0,
          knownVersion: false,
          sent: true,
          value: "resource-secret",
        }],
      }, "visit-cache");
      emit("mutation-start", "mutation", {
        phase: "start",
        method: "PATCH",
        url: "/rooms/12?token=hidden",
        body: "request-secret",
      }, "mutation-1");
      emit("mutation-trace", "server-trace", {
        type: "mutation",
        durationMs: 42,
        handlerMs: 32,
        invalidationMs: 6,
        serializeMs: 4,
        patches: [{ key: "rooms", operations: { "merge-object": 1 } }],
        invalidated: ["roomStats", "availability"],
        invalidationCount: 2,
        liveSignals: 2,
        redirect: "none",
        truncated: false,
      }, "mutation-1");
      emit("mutation-success", "mutation", {
        phase: "success",
        method: "PATCH",
        url: "/rooms/12",
      }, "mutation-1");
      emit("mutation-error", "mutation", {
        phase: "error",
        method: "POST",
        url: "/reservation",
        errorType: "ValidationError",
        detail: "validation-secret",
      }, "mutation-2");
    });

    const shadow = document.querySelector(
      "[data-fluxfast-devtools-host]"
    )!.shadowRoot!;
    const cacheTab = shadow.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="fluxfast-panel-cache"]'
    )!;
    await act(async () => cacheTab.click());

    expect(cacheTab.getAttribute("aria-selected")).toBe("true");
    expect(shadow.textContent).toContain("Server resource cache");
    expect(shadow.textContent).toContain("Browser page cache");
    expect(shadow.textContent).toContain("1 / 1");
    expect(shadow.textContent).toContain("redis");
    expect(shadow.textContent).toContain("HIT");
    expect(shadow.textContent).toContain("connection strings");

    const mutationsTab = shadow.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="fluxfast-panel-mutations"]'
    )!;
    await act(async () => mutationsTab.click());

    expect(shadow.querySelectorAll(".ff-mutation-list button")).toHaveLength(2);
    expect(shadow.textContent).toContain("validation error");
    const patchMutation = [...shadow.querySelectorAll<HTMLButtonElement>(
      ".ff-mutation-list button"
    )].find(button => button.textContent?.includes("PATCH"))!;
    await act(async () => patchMutation.click());
    const details = shadow.querySelector(".ff-mutation-detail")!;
    expect(details.textContent).toContain("PATCH /rooms/12");
    expect(details.textContent).toContain("merge-object ×1");
    expect(details.textContent).toContain("roomStats");
    expect(details.textContent).toContain("2 events");
    expect(shadow.textContent).not.toMatch(/cache-secret|transport-secret|resource-secret|request-secret|validation-secret/);
  });

  it("shows LiveManager history and safe protocol request metadata", async () => {
    const router = new FluxRouter({ deferHistory: true });
    await mountDevtools(
      <FluxProvider router={router}>
        <FluxDevtools defaultOpen />
      </FluxProvider>,
      router
    );
    const emit = (
      id: string,
      type: Parameters<typeof router.diagnostics.emit>[0]["type"],
      data: unknown,
      correlationId: string
    ) => router.diagnostics.emit({
      id,
      type,
      data,
      correlationId,
      timestamp: Date.now(),
    });

    await act(async () => {
      emit("connected", "live", {
        phase: "connect:open",
        keyCount: 2,
        reconnectAttempt: 0,
      }, "connection-1");
      emit("reconnect", "live", {
        phase: "reconnect",
        keyCount: 2,
        reconnectAttempt: 1,
      }, "connection-2");
      emit("resync", "live", {
        phase: "event",
        eventType: "resync",
        reason: "overflow",
        keyCount: 2,
      }, "live-1");
      emit("refresh", "resource-load", {
        phase: "success",
        reason: "live-reconnect",
        keyCount: 2,
      }, "live-1");
      emit("request-start", "transport", {
        phase: "start",
        requestType: "page",
        method: "GET",
        path: "/dashboard?request-secret=hidden",
        protocol: "fluxfast/1",
        capabilities: ["deferred-resources", "live-resources"],
        knownVersions: [{ key: "rooms", version: "rooms-v123456789" }],
        only: ["rooms"],
        headers: { Authorization: "Bearer header-secret" },
      }, "visit-protocol");
      emit("request-trace", "server-trace", {
        protocol: "fluxfast-devtools/1",
        type: "page",
        durationMs: 12,
        truncated: false,
        resources: [
          {
            key: "rooms",
            result: "loader",
            sent: true,
            knownVersion: false,
            deferred: false,
            value: "resource-secret",
          },
          {
            key: "profile",
            result: "omitted-known",
            sent: false,
            knownVersion: true,
            deferred: false,
          },
          {
            key: "analytics",
            result: "deferred",
            sent: false,
            knownVersion: false,
            deferred: true,
          },
        ],
      }, "visit-protocol");
      emit("request-finish", "transport", {
        phase: "success",
        requestType: "page",
        method: "GET",
        path: "/dashboard",
        status: 200,
        durationMs: 18,
        serverTrace: "valid",
      }, "visit-protocol");
    });

    const shadow = document.querySelector(
      "[data-fluxfast-devtools-host]"
    )!.shadowRoot!;
    const liveTab = shadow.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="fluxfast-panel-live"]'
    )!;
    await act(async () => liveTab.click());
    expect(shadow.textContent).toContain("Live timeline");
    expect(shadow.textContent).toContain("RECONNECT");
    expect(shadow.textContent).toContain("RESYNC");
    expect(shadow.textContent).toContain("CANONICAL REFRESH");
    expect(shadow.textContent).toContain("Queue overflow count");

    const protocolTab = shadow.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="fluxfast-panel-protocol"]'
    )!;
    await act(async () => protocolTab.click());
    expect(shadow.textContent).toContain("fluxfast/1");
    expect(shadow.textContent).toContain("fluxfast-devtools/1");
    expect(shadow.textContent).toContain("deferred-resources");
    expect(shadow.textContent).toContain("Known versions");
    expect(shadow.textContent).toContain("rooms-v1234…");
    expect(shadow.textContent).toContain("Resources sent");
    expect(shadow.textContent).toContain("Resources omitted");
    expect(shadow.textContent).not.toMatch(/request-secret|header-secret|resource-secret|Authorization|Bearer/);

    await act(async () => {
      emit("unsupported-start", "transport", {
        phase: "start",
        requestType: "page",
        method: "GET",
        path: "/future",
        protocol: "fluxfast/1",
      }, "visit-future");
      emit("unsupported-finish", "transport", {
        phase: "success",
        requestType: "page",
        serverTrace: "unsupported",
        serverTraceProtocol: "fluxfast-devtools/2",
      }, "visit-future");
    });
    expect(shadow.textContent).toContain("Unsupported DevTools trace version");
    expect(shadow.textContent).toContain("fluxfast-devtools/2");
  });

  it("has no host, store, or diagnostic subscription in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const router = new FluxRouter({ deferHistory: true });

    await mountDevtools(
      <FluxProvider router={router}>
        <FluxDevtools />
      </FluxProvider>,
      router
    );

    expect(document.querySelector("[data-fluxfast-devtools-host]")).toBeNull();
    expect(router.diagnostics.active).toBe(false);
  });

  it("contains invalid configuration without breaking the application", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = new FluxRouter({ deferHistory: true });

    await mountDevtools(
      <FluxProvider router={router}>
        <main>Application remains available</main>
        <FluxDevtools maxEvents={5_001} />
      </FluxProvider>,
      router
    );

    expect(document.body.textContent).toContain("Application remains available");
    expect(document.querySelector("[data-fluxfast-devtools-host]")).toBeNull();
    expect(router.diagnostics.active).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});
