/** Host-owned minimal probes. No authentication, ports, paths, or upstream text. */
export function healthProbe(request: Request): "healthz" | "readyz" | undefined {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  return /^\/(?:_?fluxfast)\/(healthz|readyz)$/.exec(path)?.[1] as "healthz" | "readyz" | undefined;
}

function statusResponse(status: "ok" | "ready" | "not_ready", code: number, head: boolean): Response {
  return new Response(head ? null : JSON.stringify({ status }), {
    status: code, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function serveHealth(request: Request, backendUrl: string, stopping: boolean): Promise<Response> {
  const probe = healthProbe(request);
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  if (!probe || stopping) return statusResponse("not_ready", 503, head);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3_000)]);
  try {
    const target = backendUrl.replace(/\/$/, "") + "/_fluxfast/" + probe;
    const upstream = await fetch(target, { headers: { accept: "application/json" }, redirect: "manual", cache: "no-store", signal });
    const reader = upstream.body?.getReader();
    if (!reader) return statusResponse("not_ready", 503, head);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4_096) { void reader.cancel().catch(() => undefined); return statusResponse("not_ready", 503, head); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const status = payload && typeof payload === "object" && "status" in payload ? payload.status : undefined;
    if (probe === "healthz" && upstream.status === 200 && status === "ok") return statusResponse("ok", 200, head);
    if (probe === "readyz" && upstream.status === 200 && status === "ready") return statusResponse("ready", 200, head);
    return statusResponse("not_ready", 503, head);
  } catch { return statusResponse("not_ready", 503, head); }
}
