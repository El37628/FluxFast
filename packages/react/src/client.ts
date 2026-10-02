"use client";

import React from "react";
import { hydrateRoot, type Root, type HydrationOptions } from "react-dom/client";
import { assertPageEnvelope } from "@fluxfast/core";
import type { FluxApplicationProps } from "./config.js";
import { IDENTIFIER_PREFIX, PAYLOAD_ID, ROOT_ID } from "./document.js";
import { readFluxCacheConfig, readFluxDevelopmentMetadata } from "./hydration.js";

export interface HydrateFluxApplicationOptions {
  document?: Document;
  onRecoverableError?: HydrationOptions["onRecoverableError"];
}

/** Hydrate the actual SSR markup from its exact envelope, without a fetch. */
export function hydrateFluxApplication(
  application: React.ComponentType<FluxApplicationProps>,
  options: HydrateFluxApplicationOptions = {},
): Root {
  const document = options.document ?? globalThis.document;
  const roots = document.querySelectorAll(`[id="${ROOT_ID}"]`);
  const payloads = document.querySelectorAll(`[id="${PAYLOAD_ID}"]`);
  if (roots.length !== 1 || payloads.length !== 1 || payloads[0].tagName !== "SCRIPT" || payloads[0].getAttribute("type") !== "application/json") {
    throw new TypeError("FluxFast document requires one SSR root and one JSON payload");
  }
  const payload: unknown = JSON.parse(payloads[0].textContent ?? "");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("initialEnvelope" in payload)) {
    throw new TypeError("Invalid FluxFast hydration payload");
  }
  assertPageEnvelope(payload.initialEnvelope);
  // Only server-owned application props cross this boundary; do not spread an
  // arbitrary object into React or allow it to choose a private transport URL.
  const props: FluxApplicationProps = { initialEnvelope: payload.initialEnvelope };
  if ("cache" in payload && payload.cache !== undefined) {
    props.cache = readFluxCacheConfig(payload.cache);
  }
  if ("development" in payload && payload.development !== undefined) {
    if (typeof process === "undefined" || process.env?.NODE_ENV !== "production") {
      props.development = readFluxDevelopmentMetadata(payload.development);
    }
  }
  return hydrateRoot(roots[0], React.createElement(application, props), {
    identifierPrefix: IDENTIFIER_PREFIX, onRecoverableError: options.onRecoverableError,
  });
}
