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

    const entry = [...mounted][0];
    await act(async () => entry.root.unmount());
    mounted.delete(entry);
    expect(document.querySelectorAll("[data-fluxfast-devtools-host]")).toHaveLength(0);
    expect(router.diagnostics.active).toBe(false);
    router.destroy();
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
