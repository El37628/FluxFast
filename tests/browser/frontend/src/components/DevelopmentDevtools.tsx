"use client";

import dynamic from "next/dynamic";

const DevelopmentFluxDevtools = process.env.NODE_ENV === "development"
  ? dynamic(
      () => import("@fluxfast/devtools").then(module => module.FluxDevtools),
      { ssr: false }
    )
  : function ProductionDevtoolsDisabled() {
      return null;
    };

/** Test-fixture mount that is erased from the production render path. */
export function DevelopmentDevtools() {
  return <DevelopmentFluxDevtools />;
}
