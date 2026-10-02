import { StrictMode } from "react";
import type { FluxApplicationProps } from "@fluxfast/react";
import { BrowserFixtureApplication } from "./components/BrowserFixtureApplication";

/** Exercise the same provider UI under real React StrictMode on both sides. */
export function Application(props: FluxApplicationProps) {
  return <StrictMode><BrowserFixtureApplication {...props} /></StrictMode>;
}
