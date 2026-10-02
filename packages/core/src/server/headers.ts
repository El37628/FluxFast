/** Framework-neutral HTTP header boundaries shared by server adapters. */

const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

const DEFAULT_FORWARDED_HEADERS = [
  "cookie",
  "authorization",
  "accept-language",
  "user-agent",
] as const;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

/**
 * Copy headers while removing standard and Connection-nominated per-hop fields.
 * The caller's Headers object is never modified. Works for request and response
 * headers; end-to-end fields (including separate Set-Cookie values) are retained.
 */
export function removeFluxHopByHopHeaders(input: HeadersInit): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input);
  } catch {
    // Native errors may reflect the supplied value, including credentials.
    throw new TypeError("Invalid FluxFast headers");
  }

  // Read this before removing Connection, since it can name credentials too.
  for (const token of (headers.get("connection") ?? "").split(",")) {
    const name = token.trim();
    if (HEADER_NAME.test(name)) headers.delete(name);
  }
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return headers;
}

/**
 * Select SSR cookie/authentication/language/user-agent headers, plus explicitly
 * allowlisted names. Per-hop fields are never forwarded even when allowlisted.
 * Invalid configured field names are ignored without reflecting their values.
 */
export function selectFluxForwardHeaders(
  input: HeadersInit,
  additionalHeaders: readonly string[] = []
): Headers {
  const source = removeFluxHopByHopHeaders(input);
  const selected = new Headers();
  for (const name of [...DEFAULT_FORWARDED_HEADERS, ...additionalHeaders]) {
    if (!HEADER_NAME.test(name)) continue;
    const value = source.get(name);
    if (value !== null) selected.set(name, value);
  }
  return selected;
}
