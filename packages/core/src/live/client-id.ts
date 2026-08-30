/** Shared browser/router identity used by live streams and mutations. */

import { ProtocolError } from "../errors";
import { MAX_LIVE_CLIENT_ID_LENGTH } from "./protocol";

export const HEADER_CLIENT_ID = "X-FluxFast-Client-ID";

export function assertClientId(
  clientId: string | undefined
): asserts clientId is string | undefined {
  if (clientId === undefined) return;
  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    clientId.length > MAX_LIVE_CLIENT_ID_LENGTH ||
    !/^[\x21-\x7e]+$/.test(clientId)
  ) {
    throw new ProtocolError(
      `FluxFast client ID must be printable ASCII of at most ${MAX_LIVE_CLIENT_ID_LENGTH} characters`
    );
  }
}

/** Create one opaque identity for the lifetime of a router or live manager. */
export function createClientId(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) {
    throw new Error("FluxFast client identity requires the Web Crypto API");
  }

  if (typeof cryptoApi.randomUUID === "function") {
    return `ff_${cryptoApi.randomUUID().replace(/-/g, "")}`;
  }

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return `ff_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
