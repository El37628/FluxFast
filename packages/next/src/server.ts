/** Next.js server-side helpers for the initial document request. */

import React from "react";
import { headers as nextHeaders } from "next/headers";
import { notFound } from "next/navigation";
import {
  assertPageEnvelope,
  HEADER_CAPABILITIES,
  PageEnvelope,
  PROTOCOL_MEDIA_TYPE,
  serializeCapabilities,
  TransportError,
} from "@fluxfast/core";
import { FluxNextConfig, resolveFluxBackendUrl } from "./config";

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

const DEFAULT_FORWARDED_HEADERS = [
  "cookie",
  "authorization",
  "accept-language",
  "user-agent",
] as const;

const NEVER_FORWARD = new Set([
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
]);

const INITIAL_NOT_FOUND = Symbol("fluxfast.initial-not-found");

type InitialEnvelopeResult = PageEnvelope | typeof INITIAL_NOT_FOUND;

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

async function requestInitialEnvelope({
  backendUrl,
  path,
  headers = {},
}: FetchInitialEnvelopeOptions): Promise<InitialEnvelopeResult> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("FluxFast initial paths must be origin-relative");
  }
  const fullUrl = `${backendUrl.replace(/\/$/, "")}${path}`;
  const response = await fetch(fullUrl, {
    method: "GET",
    headers: {
      ...headers,
      Accept: PROTOCOL_MEDIA_TYPE,
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      "X-FluxFast-Visit": `ssr_${Date.now().toString(36)}`,
      [HEADER_CAPABILITIES]: serializeCapabilities(),
    },
    cache: "no-store",
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new TransportError(
      `Failed to parse initial FluxFast response from ${fullUrl} (HTTP ${response.status})`,
      response.status
    );
  }
  if (response.status === 404) {
    return INITIAL_NOT_FOUND;
  }
  if (!response.ok) {
    const detail = data as { error?: { message?: string }; detail?: string };
    throw new TransportError(
      detail.error?.message ??
      detail.detail ??
      `Failed to fetch initial FluxFast envelope from ${fullUrl} (HTTP ${response.status})`,
      response.status,
      data
    );
  }
  assertPageEnvelope(data);
  return data;
}

export async function fetchInitialEnvelope(
  options: FetchInitialEnvelopeOptions
): Promise<PageEnvelope> {
  const result = await requestInitialEnvelope(options);
  if (result === INITIAL_NOT_FOUND) {
    notFound();
  }
  return result;
}

function FluxNotFound(): never {
  notFound();
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
    const allowed = new Set<string>([
      ...DEFAULT_FORWARDED_HEADERS,
      ...(config.forwardHeaders ?? []).map(name => name.toLowerCase()),
    ]);
    const forwarded: Record<string, string> = {};
    for (const name of allowed) {
      if (NEVER_FORWARD.has(name) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) continue;
      const value = incomingHeaders.get(name);
      if (value !== null) forwarded[name] = value;
    }

    const initialEnvelope = await requestInitialEnvelope({
      backendUrl: resolveFluxBackendUrl(config.backendUrl),
      path,
      headers: forwarded,
    });
    if (initialEnvelope === INITIAL_NOT_FOUND) {
      // Resolve the async page before invoking notFound(). This avoids a React
      // development instrumentation bug that measures a rejected async page
      // with an end time of -Infinity while preserving Next's real 404 status.
      return React.createElement(FluxNotFound);
    }
    return React.createElement(config.application, {
      initialEnvelope,
      clientUrl: config.clientUrl,
      cache: config.cache,
    });
  };
}
