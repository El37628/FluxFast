import { describe, expect, it, vi } from "vitest";
import { TransportError } from "../src/errors.js";
import { fetchFluxInitialPage } from "../src/server/index.js";

const backendUrl = "http://127.0.0.1:8000";
const envelope = { protocol: "fluxfast/1", page: { component: "home/index", url: "/" }, resources: {} };

function retainedResponse(status: number, bytes: Uint8Array, headers?: HeadersInit) {
  const cancelled = vi.fn();
  // A host can retain the other branch for request deduplication. Cancelling
  // our branch must not wait for that host-owned reader or the upstream end.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); },
    cancel: cancelled,
  });
  const [ours, retained] = stream.tee();
  return { response: new Response(ours, { status, headers }), retained, cancelled };
}

async function bounded<T>(operation: Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("blocked on host-owned response cancellation")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await cleanup();
  }
}

describe("initial fetch with retained response streams", () => {
  it("follows a validated canonical redirect without waiting for the retained branch", async () => {
    const redirect = retainedResponse(307, new TextEncoder().encode("discarded body"), { location: "/canonical" });
    const fetch = vi.fn().mockResolvedValueOnce(redirect.response)
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope)));
    await expect(bounded(fetchFluxInitialPage({ backendUrl, path: "/", fetch }), () => redirect.retained.cancel()))
      .resolves.toEqual({ type: "page", envelope });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(`${backendUrl}/canonical`);
    expect(redirect.cancelled).toHaveBeenCalledOnce();
  });

  it("rejects an external redirect before any second fetch even when cancellation is pending", async () => {
    const redirect = retainedResponse(307, new Uint8Array([1]), { location: "https://outside.fluxfast.invalid/secret" });
    const fetch = vi.fn().mockResolvedValue(redirect.response);
    const error = await bounded(fetchFluxInitialPage({ backendUrl, path: "/", fetch }).catch(error => error), () => redirect.retained.cancel());
    expect(error).toBeInstanceOf(TransportError);
    expect(error.status).toBe(307);
    expect(error.message).not.toContain("secret");
    expect(fetch).toHaveBeenCalledOnce();
    expect(redirect.cancelled).toHaveBeenCalledOnce();
  });

  it("keeps the redirect bound fail-closed without waiting for retained streams", async () => {
    const redirect = retainedResponse(302, new Uint8Array([1]), { location: "/canonical" });
    const fetch = vi.fn().mockResolvedValue(redirect.response);
    const error = await bounded(fetchFluxInitialPage({ backendUrl, path: "/", fetch, maxRedirects: 0 }).catch(error => error), () => redirect.retained.cancel());
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toContain("exceeded the redirect limit");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an oversized streamed error promptly and releases its reader", async () => {
    const upstream = retainedResponse(502, new Uint8Array(1024 * 1024 + 1));
    const fetch = vi.fn().mockResolvedValue(upstream.response);
    const error = await bounded(fetchFluxInitialPage({ backendUrl, path: "/", fetch }).catch(error => error), () => upstream.retained.cancel());
    expect(error).toBeInstanceOf(TransportError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("Initial FluxFast error response exceeded the size limit");
    expect(upstream.response.body!.locked).toBe(false);
    expect(upstream.cancelled).toHaveBeenCalledOnce();
  });

  it("discard cancellation rejection cannot replace a validated redirect result", async () => {
    const redirect = new Response(new ReadableStream({ cancel() { throw new Error("upstream cancellation detail"); } }), { status: 307, headers: { location: "/canonical" } });
    const fetch = vi.fn().mockResolvedValueOnce(redirect).mockResolvedValueOnce(new Response(JSON.stringify(envelope)));
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", fetch })).resolves.toEqual({ type: "page", envelope });
  });
});
