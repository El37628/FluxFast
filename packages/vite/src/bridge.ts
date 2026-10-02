import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { removeFluxHopByHopHeaders } from "@fluxfast/core/server";

/** Preserve raw path/query; neither Host nor forwarded headers select a target. */
export function webRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const raw = incoming.url ?? "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(raw)) {
    throw new TypeError("Invalid request path");
  }
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
  }
  // Cookie uses '; ', not Fetch Headers' generic comma separator. Node already
  // combines repeated Cookie fields correctly (including HTTP/2 compatibility).
  if (typeof incoming.headers.cookie === "string") headers.set("cookie", incoming.headers.cookie);
  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
  return new Request("http://fluxfast.invalid" + raw, {
    method, headers, signal, ...(body === undefined ? {} : { body, duplex: "half" }),
  } as RequestInit);
}

/** Unbuffered response bridge with cookie separation, backpressure, cancellation. */
export async function writeWebResponse(response: Response, outgoing: ServerResponse, signal: AbortSignal): Promise<void> {
  const headers = removeFluxHopByHopHeaders(response.headers);
  outgoing.statusCode = response.status;
  for (const [name, value] of headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
  const cookies = headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  const reader = response.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); return; }
    outgoing.flushHeaders();
    if (reader) {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!outgoing.write(value)) await once(outgoing, "drain", { signal });
      }
    }
    if (!signal.aborted) outgoing.end();
  } finally {
    signal.removeEventListener("abort", cancel);
    if (signal.aborted) cancel();
    reader?.releaseLock();
  }
}
