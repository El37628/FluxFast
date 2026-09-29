"use client";

import { FluxDevtools } from "@fluxfast/devtools";

/** Test-fixture mount that is erased from the production render path. */
export function DevelopmentDevtools() {
  if (process.env.NODE_ENV !== "development") return null;
  return <FluxDevtools />;
}
