import { defineFluxConfig } from "@fluxfast/next";
import { FluxApplication } from "@/.fluxfast/pages.generated";

export const fluxConfig = defineFluxConfig({
  application: FluxApplication,
  cache: { maxResources: 32, maxPages: 8 },
});
