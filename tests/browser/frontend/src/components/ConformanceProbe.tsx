"use client";

import type { FluxDiagnosticEvent, PageEnvelope } from "@fluxfast/core";
import { useRouter } from "@fluxfast/next";
import { useEffect, useRef } from "react";
import type { FluxConformanceBridge } from "../../../../adapter-conformance/harness";

/** Opt-in test facade. It uses public APIs and never participates in rendering. */
export function ConformanceProbe({ initialEnvelope }: { initialEnvelope?: PageEnvelope }) {
  const router = useRouter();
  const initial = useRef(initialEnvelope);
  const events = useRef<FluxDiagnosticEvent[]>([]);
  useEffect(() => {
    if (!window.fluxConformanceEnabled) return;
    const bridge: FluxConformanceBridge = {
      page: () => router.pageStore.getSnapshot(),
      resource: key => router.resourceStore.getStateSnapshot(key),
      records: () => router.resourceStore.getRecordsSnapshot(),
      knownVersions: () => router.resourceStore.exportKnownVersions(),
      visit: (url, options) => router.visit(url, options),
      prefetch: url => router.prefetch(url),
      refresh: only => router.refresh({ only }),
      retry: key => router.loadResources([key], { reason: "retry" }),
      mutate: (url, data) => router.mutate(url, data),
      diagnostics: () => [...events.current],
      initialEnvelope: () => initial.current,
    };
    window.fluxAdapterConformance = bridge;
    const stop = process.env.NODE_ENV === "development"
      ? router.diagnostics.subscribe(event => {
          events.current.push(event);
          if (events.current.length > 512) events.current.shift();
        })
      : () => {};
    return () => {
      stop();
      if (window.fluxAdapterConformance === bridge) delete window.fluxAdapterConformance;
    };
  }, [router]);
  return null;
}
