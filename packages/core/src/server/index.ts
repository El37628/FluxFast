/** Server adapter primitives. Deliberately not exported from the Core root. */

export { fetchFluxInitialPage } from "./initial-page.js";
export { createFluxTransportProxy } from "./proxy.js";

export {
  removeFluxHopByHopHeaders,
  selectFluxForwardHeaders,
} from "./headers.js";
export type {
  FetchFluxInitialPageOptions,
  FluxDevelopmentMetadata,
  FluxInitialPageResult,
  FluxTransportProxyOptions,
} from "./types.js";
