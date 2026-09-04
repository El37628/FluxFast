"use client";

import React, { createContext, useContext, useEffect, useMemo } from "react";
import { createFetchTransport, FluxRouter, PageEnvelope } from "@fluxfast/core";
import { ComponentRegistry } from "./resolver.js";
import { FluxCacheConfig } from "./config.js";

export interface FluxContextValue {
  router: FluxRouter;
  registry: ComponentRegistry;
}

export const FluxContext = createContext<FluxContextValue | null>(null);

export interface FluxProviderProps {
  initialEnvelope?: PageEnvelope;
  registry?: ComponentRegistry;
  router?: FluxRouter;
  clientUrl?: string;
  cache?: FluxCacheConfig;
  children: React.ReactNode;
}

export function FluxProvider({
  initialEnvelope,
  registry,
  router: customRouter,
  clientUrl,
  cache,
  children,
}: FluxProviderProps) {
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
