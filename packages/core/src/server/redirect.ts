/** Internal redirect mechanics; adapter rendering never enters this module. */

import { TransportError } from "../errors.js";

export const DEFAULT_MAX_INITIAL_REDIRECTS = 20;

export function isFluxRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

/** Resolve canonical backend redirects without forwarding credentials elsewhere. */
export function resolveFluxRedirect(
  location: string,
  requestUrl: string,
  backendOrigin: string,
  status: number
): URL {
  let destination: URL;
  try {
    destination = new URL(location, requestUrl);
  } catch {
    throw new TransportError(
      "Initial FluxFast response has an invalid redirect",
      status
    );
  }
  if (destination.origin !== backendOrigin || destination.username || destination.password) {
    throw new TransportError(
      "Initial FluxFast response redirects outside the configured backend origin",
      status
    );
  }
  return destination;
}
