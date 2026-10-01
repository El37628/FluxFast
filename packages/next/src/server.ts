/** Next.js server-side helpers for the initial document request. */

import React from "react";
import { headers as nextHeaders } from "next/headers";
import { notFound } from "next/navigation";
import { PageEnvelope } from "@fluxfast/core";
import { fetchFluxInitialPage, selectFluxForwardHeaders } from "@fluxfast/core/server";
import { FluxNextConfig, resolveFluxBackendUrl } from "./config.js";
import type { FluxDevelopmentMetadata } from "./config.js";

export { createFluxHealthHandler } from "./health.js";
export type { FluxHealthHandlerOptions } from "./health.js";
export { createFluxTransportHandler } from "./transport.js";
export type {
  FluxTransportHandlerOptions,
  FluxTransportRouteContext,
} from "./transport.js";

export interface FetchInitialEnvelopeOptions {
  backendUrl: string;
  path: string;
  headers?: Record<string, string>;
}

export type FluxSearchParams = Record<
  string,
  string | string[] | undefined
>;

export interface FluxNextPageProps {
  params: Promise<{ flux?: string[] }> | { flux?: string[] };
  searchParams?: Promise<FluxSearchParams> | FluxSearchParams;
}

const INITIAL_NOT_FOUND = Symbol("fluxfast.initial-not-found");

interface InitialEnvelopePayload {
  envelope: PageEnvelope;
  development?: FluxDevelopmentMetadata;
}

type InitialEnvelopeResult = InitialEnvelopePayload | typeof INITIAL_NOT_FOUND;

export function buildFluxPath(
  segments: string[] | undefined,
  searchParams: FluxSearchParams = {}
): string {
  const pathname = segments?.length
    ? `/${segments.map(encodeURIComponent).join("/")}`
    : "/";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.append(key, value);
    }
  }
  const encoded = query.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
}

async function requestInitialEnvelope(
  options: FetchInitialEnvelopeOptions
): Promise<InitialEnvelopeResult> {
  const result = await fetchFluxInitialPage({
    ...options,
    diagnostics: process.env.NODE_ENV !== "production",
  });
  return result.type === "not-found" ? INITIAL_NOT_FOUND : result;
}

export async function fetchInitialEnvelope(
  options: FetchInitialEnvelopeOptions
): Promise<PageEnvelope> {
  const result = await requestInitialEnvelope(options);
  if (result === INITIAL_NOT_FOUND) {
    notFound();
  }
  return result.envelope;
}

function FluxNotFoundTimingAnchor() {
  return null;
}

const FluxNotFoundControl = React.lazy(() => notFound());

function createNotFoundElement() {
  // React 19.2's development RSC profiler measures a rejected component with
  // childrenEndTime = -Infinity (tracked as vercel/next.js#86060). A lazy
  // control-flow boundary avoids attributing that rejection to a named server
  // component. The completed sibling below still gives the fulfilled parent a
  // valid timing boundary.
  return React.createElement(FluxNotFoundControl);
}

export function createFluxNextPage(config: FluxNextConfig) {
  return async function FluxNextPage({
    params,
    searchParams = {},
  }: FluxNextPageProps) {
    const [resolvedParams, resolvedSearch, incomingHeaders] = await Promise.all([
      params,
      searchParams,
      nextHeaders(),
    ]);
    const path = buildFluxPath(resolvedParams.flux, resolvedSearch);
    const forwarded = selectFluxForwardHeaders(incomingHeaders, config.forwardHeaders ?? []);

    const initial = await requestInitialEnvelope({
      backendUrl: resolveFluxBackendUrl(config.backendUrl),
      path,
      headers: Object.fromEntries(forwarded),
    });
    if (initial === INITIAL_NOT_FOUND) {
      // Unlike Suspense or rendering a fallback directly, this preserves
      // Next's real 404 response status.
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(FluxNotFoundTimingAnchor),
        createNotFoundElement()
      );
    }
    return React.createElement(config.application, {
      initialEnvelope: initial.envelope,
      ...(initial.development === undefined
        ? {}
        : { development: initial.development }),
      clientUrl: config.clientUrl,
      cache: config.cache,
    });
  };
}
