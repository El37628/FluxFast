import { defineFluxConfig } from "@fluxfast/next";
import { FluxApplication } from "@/.fluxfast/pages.generated";
import type {} from "@/.fluxfast/types.generated";

export const fluxConfig = defineFluxConfig({
  application: FluxApplication,
  cache: { maxResources: 32, maxPages: 8 },
});
