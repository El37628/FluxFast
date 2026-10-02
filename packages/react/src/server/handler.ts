import { TransportError } from "@fluxfast/core";
import { createFluxTransportProxy, fetchFluxInitialPage, selectFluxForwardHeaders } from "@fluxfast/core/server";
import type { FluxApplicationProps, FluxCacheConfig } from "../config.js";
import { PAYLOAD_ID, PAYLOAD_MARKER, SSR_MARKER } from "../document.js";
import { validateRenderTimeout, type RenderFluxApplicationOptions } from "./render.js";
import { readFluxCacheConfig } from "../hydration.js";

export type FluxReactRender = (
  props: FluxApplicationProps,
  options: RenderFluxApplicationOptions,
) => Promise<string>;

export interface FluxReactHandlerOptions {
  /** Trusted private backend address; never obtained from incoming HTTP data. */
  backendUrl: string;
  render: FluxReactRender;
  /** Trusted host template containing exactly one SSR and payload marker. */
  template: string | ((request: Request) => string | Promise<string>);
  forwardHeaders?: readonly string[];
  cache?: FluxCacheConfig;
  /** Opt-in only; suppressed when NODE_ENV is production. */
  development?: boolean;
  /** Initial HTTP and render deadline; live proxy streams are not timed out. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function htmlResponse(body: string | null, status: number): Response {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  } });
}

function failureDocument(status: number): string {
  const title = status === 404 ? "Page not found" : status === 401 || status === 403
    ? "Access denied" : "Page unavailable";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
}

function safePayload(props: FluxApplicationProps): string {
  // Even non-executable JSON script text must not contain an HTML closing tag.
  return JSON.stringify(props).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function renderDocument(template: string, markup: string, props: FluxApplicationProps): string {
  for (const marker of [SSR_MARKER, PAYLOAD_MARKER]) {
    if (template.split(marker).length !== 2) {
      throw new TypeError("FluxFast template requires exactly one SSR and payload marker");
    }
  }
  // Do not run a second replace over inserted application markup: user text
  // can legitimately contain the other marker. Split the template first.
  const payload = `<script id="${PAYLOAD_ID}" type="application/json">${safePayload(props)}</script>`;
  return template.split(/(<!--fluxfast:ssr-->|<!--fluxfast:payload-->)/g)
    .map(part => part === SSR_MARKER ? markup : part === PAYLOAD_MARKER ? payload : part).join("");
}

function untilAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("FluxFast initial request aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Web Request/Response boundary reused by SSR hosts; no socket or asset server. */
export function createFluxReactHandler(options: FluxReactHandlerOptions): (request: Request) => Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  validateRenderTimeout(timeoutMs);
  const cache = options.cache === undefined ? undefined : readFluxCacheConfig(options.cache);
  let backend: URL;
  try { backend = new URL(options.backendUrl); }
  catch { throw new TypeError("FluxFast backendUrl must be a trusted HTTP(S) URL"); }
  if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password || backend.search || backend.hash) {
    throw new TypeError("FluxFast backendUrl must be a trusted HTTP(S) URL without credentials, query, or fragment");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return async request => {
    const development = options.development === true && process.env.NODE_ENV !== "production";
    const url = new URL(request.url);
    if (request.headers.get("x-fluxfast") === "1") {
      const headers = new Headers(request.headers);
      if (!development) headers.delete("x-fluxfast-devtools");
      const proxy = createFluxTransportProxy({ backendUrl: options.backendUrl, fetch: fetchImplementation });
      const result = await proxy(new Request(request, { headers }), url.pathname);
      if (development) return result;
      const responseHeaders = new Headers(result.headers);
      responseHeaders.delete("x-fluxfast-devtools-trace");
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers: responseHeaders });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    try {
      if (signal.aborted) throw new Error("FluxFast initial request aborted");
      const initial = await untilAbort(fetchFluxInitialPage({
        backendUrl: options.backendUrl, path: url.pathname + url.search,
        headers: selectFluxForwardHeaders(request.headers, options.forwardHeaders),
        diagnostics: development,
        fetch: (input, init) => fetchImplementation(input, { ...init, signal }),
      }), signal);
      if (initial.type === "not-found") {
        return htmlResponse(request.method === "HEAD" ? null : failureDocument(404), 404);
      }
      const props: FluxApplicationProps = {
        initialEnvelope: initial.envelope,
        ...(cache === undefined ? {} : { cache }),
        ...(initial.development === undefined ? {} : { development: initial.development }),
      };
      const template = typeof options.template === "string" ? options.template : await untilAbort(Promise.resolve(options.template(request)), signal);
      const markup = await untilAbort(options.render(props, { signal, timeoutMs }), signal);
      if (signal.aborted) throw new Error("FluxFast initial request aborted");
      const html = renderDocument(template, markup, props);
      return htmlResponse(request.method === "HEAD" ? null : html, 200);
    } catch (error) {
      const status = error instanceof TransportError && (error.status === 401 || error.status === 403)
        ? error.status : signal.aborted ? 503 : 500;
      // No native exception, backend address, response body or credentials cross
      // into this public error document. Never invent a valid page envelope.
      return htmlResponse(request.method === "HEAD" ? null : failureDocument(status), status);
    } finally {
      clearTimeout(timer);
    }
  };
}
