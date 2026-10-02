import { defineFluxConfig } from "@fluxfast/next";
import { BrowserFixtureApplication } from "@/components/BrowserFixtureApplication";
import type {} from "@/.fluxfast/types.generated";

export const fluxConfig = defineFluxConfig({
  application: BrowserFixtureApplication,
  forwardHeaders: ["authorization"],
  cache: { maxResources: 32, maxPages: 8 },
});
