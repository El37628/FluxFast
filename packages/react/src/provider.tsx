"use client";

import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { createFetchTransport, FluxRouter, PageEnvelope } from "@fluxfast/core";
import { ComponentRegistry } from "./resolver.js";
import { FluxCacheConfig } from "./config.js";
import type { FluxDevelopmentMetadata } from "./config.js";

export interface FluxContextValue {
  router: FluxRouter;
  registry: ComponentRegistry;
}

export const FluxContext = createContext<FluxContextValue | null>(null);

export interface FluxProviderProps {
  initialEnvelope?: PageEnvelope;
  development?: FluxDevelopmentMetadata;
  registry?: ComponentRegistry;
  router?: FluxRouter;
  clientUrl?: string;
  cache?: FluxCacheConfig;
  children: React.ReactNode;
}

export function FluxProvider({
  initialEnvelope,
  development,
  registry,
  router: customRouter,
  clientUrl,
  cache,
  children,
}: FluxProviderProps) {
  const didBootstrapDiagnostics = useRef(false);
  const router = useMemo(() => {
    if (customRouter) {
      return customRouter;
    }

    return new FluxRouter({
      initialEnvelope,
      transport: createFetchTransport(clientUrl),
      maxResources: cache?.maxResources,
      maxPages: cache?.maxPages,
      deferHistory: true,
    });
  }, [customRouter, initialEnvelope, clientUrl, cache?.maxPages, cache?.maxResources]);

  const value = useMemo(
    () => ({ router, registry: registry ?? {} }),
    [router, registry]
  );

  useEffect(() => {
    if (
      (typeof process !== "undefined" && process.env?.NODE_ENV === "production") ||
      development === undefined ||
      didBootstrapDiagnostics.current
    ) {
      return;
    }
    didBootstrapDiagnostics.current = true;
    const requestId = typeof development.initialServerTrace.requestId === "string"
      ? development.initialServerTrace.requestId
      : "ssr";
    const hydratedAt = Date.now();
    const durationMs = typeof development.initialServerTrace.durationMs === "number"
      ? development.initialServerTrace.durationMs
      : 0;
    router.diagnostics.bootstrap([
      {
        id: `ssr_server_trace_${requestId}`,
        timestamp: Math.max(0, hydratedAt - durationMs),
        type: "server-trace",
        correlationId: requestId,
        data: {
          ...development.initialServerTrace,
          path: development.initialPath,
          source: "ssr",
        },
      },
      {
        id: `ssr_hydrated_${requestId}`,
        timestamp: hydratedAt,
        type: "lifecycle",
        correlationId: requestId,
        data: { phase: "hydrated", path: development.initialPath },
      },
    ]);
  }, [development, router]);

  useEffect(() => {
    if (!customRouter) {
      router.startHistory();
      void router.startInitialDeferred().catch(() => undefined);
    }
    router.startLive();

    return () => {
      router.stopLive();
      if (!customRouter) router.stopHistory();
    };
  }, [customRouter, router]);

  return (
    <FluxContext.Provider value={value}>
      {children}
    </FluxContext.Provider>
  );
}

export function useFluxContext(): FluxContextValue {
  const ctx = useContext(FluxContext);
  if (!ctx) {
    throw new Error(
      "useFluxContext must be used within a <FluxProvider> or <FluxRoot>"
    );
  }
  return ctx;
}
