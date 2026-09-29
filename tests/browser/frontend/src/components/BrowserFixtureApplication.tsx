"use client";

import {
  FluxProvider,
  resolveComponent,
  useFluxContext,
  usePage,
  type FluxApplicationProps,
} from "@fluxfast/next";
import { Suspense } from "react";
import { fluxPages } from "@/.fluxfast/pages.generated";
import { DevelopmentDevtools } from "@/components/DevelopmentDevtools";

function FixturePage() {
  const page = usePage();
  const { registry } = useFluxContext();
  if (!page.component) return null;
  const Page = resolveComponent(page.component, registry);
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  );
}

/** Persistent provider shell used to exercise DevTools across page changes. */
export function BrowserFixtureApplication({
  initialEnvelope,
  development,
  clientUrl,
  cache,
}: FluxApplicationProps) {
  return (
    <FluxProvider
      initialEnvelope={initialEnvelope}
      development={development}
      registry={fluxPages}
      clientUrl={clientUrl}
      cache={cache}
    >
      <FixturePage />
      <DevelopmentDevtools />
    </FluxProvider>
  );
}
