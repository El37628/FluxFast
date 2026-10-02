// @vitest-environment happy-dom

import React, { StrictMode, act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FluxDiagnosticEvent } from "@fluxfast/core";
import { FluxProvider, useFluxContext } from "../src/provider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

describe("FluxProvider SSR diagnostics", () => {
  it("hydrates one SSR trace and lifecycle marker under StrictMode", async () => {
    const events: FluxDiagnosticEvent[] = [];

    function Probe() {
      const { router } = useFluxContext();
      useEffect(
        () => router.diagnostics.subscribe(event => events.push(event)),
        [router]
      );
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.add(root);
    await act(async () => root.render(
      <StrictMode>
        <FluxProvider
          initialEnvelope={{
            protocol: "fluxfast/1",
            page: { component: "rooms/index", url: "/rooms" },
            resources: {},
          }}
          development={{
            initialPath: "/rooms",
            initialServerTrace: {
              protocol: "fluxfast-devtools/1",
              requestId: "ffdev_ssr",
              type: "page",
              durationMs: 3,
              pageMs: 1,
              resourcesMs: 1,
              serializeMs: 1,
              resources: [],
              truncated: false,
            },
          }}
        >
          <Probe />
        </FluxProvider>
      </StrictMode>
    ));

    const bootstrapEvents = events.filter(event => event.id.startsWith("ssr_"));
    expect(bootstrapEvents.map(event => event.type)).toEqual([
      "server-trace",
      "lifecycle",
    ]);
    expect(bootstrapEvents[0]).toMatchObject({
      correlationId: "ffdev_ssr",
      data: { path: "/rooms", source: "ssr" },
    });
    expect(bootstrapEvents[1]).toMatchObject({
      correlationId: "ffdev_ssr",
      data: { phase: "hydrated", path: "/rooms" },
    });
    expect(bootstrapEvents[0].timestamp).toBeLessThanOrEqual(
      bootstrapEvents[1].timestamp
    );
  });
});
