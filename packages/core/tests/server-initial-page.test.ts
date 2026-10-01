import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { ProtocolError, TransportError } from "../src/errors.js";
import { HEADER_DEVTOOLS, HEADER_DEVTOOLS_TRACE, MAX_DEVTOOLS_TRACE_HEADER_CHARS } from "../src/transport.js";
import { fetchFluxInitialPage, selectFluxForwardHeaders } from "../src/server/index.js";

const backendUrl = "http://127.0.0.1:8000";
const envelope = {
  protocol: "fluxfast/1", page: { component: "rooms/index", url: "/rooms?tag=a&tag=b" },
  resources: { rooms: { version: "opaque", value: [{ id: 1 }] } },
  resourceKeys: ["rooms", "report"], deferred: ["report"], live: ["rooms"],
};
const trace = {
  protocol: "fluxfast-devtools/1", requestId: "ffdev_0123456789abcdef", type: "page",
  durationMs: 4.5, pageMs: 1, resourcesMs: 2, serializeMs: 0.5, resources: [], truncated: false,
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const response = (data: unknown = envelope, init?: ResponseInit) => new Response(JSON.stringify(data), init);

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe("framework-neutral initial page fetch", () => {
  it("fetches real HTTP canonical pages and 404s without contacting an external redirect origin", async () => {
    const externalRequests = vi.fn();
    const target = createServer((_request, response) => { externalRequests(); response.end(JSON.stringify(envelope)); });
    const targetUrl = await listen(target);
    const requests: { url?: string; cookie?: string; authorization?: string }[] = [];
    const backend = createServer((request, response) => {
      requests.push({ url: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization });
      if (request.url === "/canonical") {
        response.writeHead(307, { location: "/rooms/?tag=a&tag=b" }); response.end();
      } else if (request.url === "/escape") {
        response.writeHead(302, { location: `${targetUrl}/stolen` }); response.end();
      } else if (request.url === "/missing") {
        response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ detail: "Not Found" }));
      } else {
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify(envelope));
      }
    });
    try {
      const backendUrl = await listen(backend);
      const headers = { cookie: "session=example", authorization: "Bearer example" };
      await expect(fetchFluxInitialPage({ backendUrl, path: "/canonical", headers })).resolves.toEqual({ type: "page", envelope });
      expect(requests.slice(0, 2)).toEqual([
        { url: "/canonical", ...headers }, { url: "/rooms/?tag=a&tag=b", ...headers },
      ]);
      await expect(fetchFluxInitialPage({ backendUrl, path: "/missing" })).resolves.toEqual({ type: "not-found" });
      await expect(fetchFluxInitialPage({ backendUrl, path: "/escape", headers })).rejects.toBeInstanceOf(TransportError);
      expect(externalRequests).not.toHaveBeenCalled();
    } finally {
      await Promise.all([close(backend), close(target)]);
    }
  });
  it("preserves page data and authoritative protocol headers without mutating the input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const incoming = new Headers({
      cookie: "session=example", authorization: "Bearer example", "accept-language": "en",
      "user-agent": "example", "x-tenant": "tenant", "x-unlisted": "do-not-forward",
    });
    const headers = selectFluxForwardHeaders(incoming, ["X-Tenant"]);
    headers.set("accept", "spoof"); headers.set("x-fluxfast", "spoof");
    headers.set("x-fluxfast-protocol", "spoof"); headers.set("x-fluxfast-visit", "spoof");
    headers.set("x-fluxfast-capabilities", "spoof"); headers.set("x-fluxfast-devtools", "1");
    const result = await fetchFluxInitialPage({ backendUrl: `${backendUrl}/`, path: "/rooms?tag=a&tag=b", headers, fetch: fetchMock });
    expect(result).toEqual({ type: "page", envelope });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(`${backendUrl}/rooms?tag=a&tag=b`);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    const sent = new Headers(options.headers);
    expect(sent.get("x-fluxfast-visit")).toMatch(/^ssr_[a-z0-9]+$/);
    sent.delete("x-fluxfast-visit");
    expect(Object.fromEntries(sent)).toEqual({
      accept: "application/vnd.fluxfast+json", authorization: "Bearer example", cookie: "session=example",
      "accept-language": "en", "user-agent": "example", "x-tenant": "tenant",
      "x-fluxfast": "1", "x-fluxfast-protocol": "1", "x-fluxfast-capabilities": "deferred-resources,live-resources",
    });
    expect(headers.get("accept")).toBe("spoof");
    expect(headers.get("x-fluxfast-devtools")).toBe("1");
  });

  it("uses global fetch when no fetch implementation is injected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFluxInitialPage({ backendUrl, path: "/" })).resolves.toEqual({ type: "page", envelope });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves explicit custom headers but strips standard and nominated per-hop fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await fetchFluxInitialPage({ backendUrl, path: "/", fetch: fetchMock, headers: {
      "x-custom": "allowed", host: "evil.example", "content-length": "999", "transfer-encoding": "chunked",
      connection: "cookie, x-hop", cookie: "must-not-send", "x-hop": "must-not-send",
    } });
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    for (const name of ["host", "content-length", "transfer-encoding", "connection", "cookie", "x-hop"]) expect(headers.has(name)).toBe(false);
    expect(headers.get("x-custom")).toBe("allowed");
  });

  it("preserves an explicit backend path prefix and encoded route segments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await fetchFluxInitialPage({ backendUrl: `${backendUrl}/api/`, path: "/rooms/a%2Fb?empty=&tag=sea+view", fetch: fetchMock });
    expect(fetchMock.mock.calls[0][0]).toBe(`${backendUrl}/api/rooms/a%2Fb?empty=&tag=sea+view`);
  });

  it.each(["", "rooms", "//evil.example/rooms", "https://evil.example/rooms", "/\\evil.example/rooms", "/rooms\r\nCookie:secret", "/rooms?token=raw value"])(
    "rejects malformed path %s before any fetch", async path => {
      const fetchMock = vi.fn();
      await expect(fetchFluxInitialPage({ backendUrl, path, fetch: fetchMock })).rejects.toBeInstanceOf(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["invalid", "file:///secret", "http://user:secret@localhost:8000", `${backendUrl}?token=secret`, `${backendUrl}#secret`])(
    "rejects unsafe backend configuration without reflecting it", async backendUrl => {
      const fetchMock = vi.fn();
      const error = await fetchFluxInitialPage({ backendUrl, path: "/", fetch: fetchMock }).catch(error => error);
      expect(error).toBeInstanceOf(TypeError); expect(error.message).not.toContain("secret");
      expect(error.cause).toBeUndefined(); expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid redirect bound %s", async maxRedirects => {
    const fetchMock = vi.fn();
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", maxRedirects, fetch: fetchMock })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([301, 302, 303, 307, 308])("follows only canonical HTTP %s redirects with authentication", async status => {
    const cancel = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
      status, headers: { location: "../rooms/?tag=a&tag=b" },
    })).mockResolvedValueOnce(response());
    await expect(fetchFluxInitialPage({ backendUrl, path: "/rooms", headers: { cookie: "session=example", authorization: "Bearer example" }, fetch: fetchMock }))
      .resolves.toEqual({ type: "page", envelope });
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`${backendUrl}/rooms/?tag=a&tag=b`);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("cookie")).toBe("session=example");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer example");
      expect(init.redirect).toBe("manual");
    }
  });

  it.each(["https://evil.example/secret", "//evil.example/secret", "http://user:secret@127.0.0.1:8000/", "http://[secret"])(
    "cancels and rejects unsafe redirect %s without a second request", async location => {
      const cancel = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 307, headers: { location } }));
      const error = await fetchFluxInitialPage({ backendUrl, path: "/", fetch: fetchMock }).catch(error => error);
      expect(error).toBeInstanceOf(TransportError); expect(error.status).toBe(307);
      expect(error.message).not.toContain("secret"); expect(cancel).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it("accepts twenty redirects but rejects and cancels the twenty-first", async () => {
    const success = vi.fn().mockImplementation(async () => success.mock.calls.length <= 20
      ? new Response(null, { status: 307, headers: { location: "/rooms/" } }) : response());
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", fetch: success })).resolves.toEqual({ type: "page", envelope });
    expect(success).toHaveBeenCalledTimes(21);
    const cancel = vi.fn();
    const loop = vi.fn().mockImplementation(async () => new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: "/loop" } }));
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", fetch: loop })).rejects.toThrow("exceeded the redirect limit");
    expect(loop).toHaveBeenCalledTimes(21); expect(cancel).toHaveBeenCalledTimes(21);
  });

  it("supports disabling redirects explicitly", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: "/canonical" } }));
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", fetch: fetchMock, maxRedirects: 0 })).rejects.toThrow("exceeded the redirect limit");
    expect(fetchMock).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns not-found without a framework import or rendering side effect", async () => {
    await expect(fetchFluxInitialPage({ backendUrl, path: "/missing", fetch: vi.fn().mockResolvedValue(response({ detail: "Not Found" }, { status: 404 })) }))
      .resolves.toEqual({ type: "not-found" });
  });

  it.each([
    [422, { error: { message: "Request validation failed", details: { amount: ["Invalid"] } } }, "Request validation failed"],
    [403, { detail: "Forbidden" }, "Forbidden"], [503, {}, "Failed to fetch initial FluxFast envelope"],
    [500, null, "Failed to fetch initial FluxFast envelope"], [500, { detail: {} }, "Failed to fetch initial FluxFast envelope"],
  ])("maps HTTP %s failures to the existing error/status/detail contract", async (status, data, message) => {
    const error = await fetchFluxInitialPage({ backendUrl, path: "/rooms", fetch: vi.fn().mockResolvedValue(response(data, { status: status as number })) }).catch(error => error);
    expect(error).toBeInstanceOf(TransportError); expect(error.status).toBe(status); expect(error.details).toEqual(data); expect(error.message).toContain(message);
  });

  it.each([200, 404, 502])("preserves non-JSON HTTP %s parse failure semantics", async status => {
    const error = await fetchFluxInitialPage({ backendUrl, path: "/rooms", fetch: vi.fn().mockResolvedValue(new Response("not JSON", { status })) }).catch(error => error);
    expect(error).toBeInstanceOf(TransportError); expect(error.status).toBe(status); expect(error.message).toContain("Failed to parse initial FluxFast response");
  });

  it("rejects a malformed successful envelope", async () => {
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", fetch: vi.fn().mockResolvedValue(response({ ...envelope, resources: { rooms: { version: 1, value: [] } } })) })).rejects.toBeInstanceOf(ProtocolError);
  });

  it("preserves native network rejection when there is no HTTP response", async () => {
    const failure = new TypeError("Network unavailable");
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", fetch: vi.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
  });

  it("bounds streamed error bytes independently of Content-Length and cancels upstream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"detail":"'));
        controller.enqueue(new TextEncoder().encode("🧪".repeat(300_000)));
      }, cancel,
    });
    const error = await fetchFluxInitialPage({ backendUrl, path: "/", fetch: vi.fn().mockResolvedValue(new Response(body, { status: 502, headers: { "content-length": "10" } })) }).catch(error => error);
    expect(error).toBeInstanceOf(TransportError); expect(error.status).toBe(502);
    expect(error.message).toBe("Initial FluxFast error response exceeded the size limit");
    expect(error.details).toBeUndefined(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts an error body at the exact one-MiB limit", async () => {
    const overhead = JSON.stringify({ detail: "" }).length;
    const detail = "a".repeat(1024 * 1024 - overhead);
    const error = await fetchFluxInitialPage({ backendUrl, path: "/", fetch: vi.fn().mockResolvedValue(response({ detail }, { status: 500 })) }).catch(error => error);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.status).toBe(500); expect(error.message.length).toBe(detail.length);
    expect(error.details.detail.length).toBe(detail.length);
  });

  it("decodes multibyte JSON correctly across streamed byte boundaries", async () => {
    const detail = "Était interdit 🧪";
    const bytes = new TextEncoder().encode(JSON.stringify({ detail }));
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const error = await fetchFluxInitialPage({ backendUrl, path: "/", fetch: vi.fn().mockResolvedValue(new Response(body, { status: 403 })) }).catch(error => error);
    expect(error).toBeInstanceOf(TransportError); expect(error.message).toBe(detail); expect(error.details).toEqual({ detail });
  });

  it("does not impose the diagnostic error bound on successful application data", async () => {
    const large = { ...envelope, resources: { large: { version: "opaque", value: "a".repeat(1024 * 1024 + 1) } } };
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", fetch: vi.fn().mockResolvedValue(response(large)) })).resolves.toEqual({ type: "page", envelope: large });
  });

  it("enables diagnostics only through the explicit host flag, independent of NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn().mockResolvedValue(response(envelope, { headers: { [HEADER_DEVTOOLS_TRACE]: encode(trace) } }));
    const result = await fetchFluxInitialPage({ backendUrl, path: "/rooms?token=not-recorded", diagnostics: true, fetch: fetchMock });
    expect(result).toEqual({ type: "page", envelope, development: { initialPath: "/rooms", initialServerTrace: trace } });
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get(HEADER_DEVTOOLS)).toBe("1");
    expect(JSON.stringify("development" in result ? result.development : {})).not.toContain("not-recorded");
  });

  it("does not forward a caller's diagnostic opt-in or return metadata by default", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn().mockResolvedValue(response(envelope, { headers: { [HEADER_DEVTOOLS_TRACE]: encode(trace) } }));
    await expect(fetchFluxInitialPage({ backendUrl, path: "/", headers: { "x-fluxfast-devtools": "1" }, fetch: fetchMock })).resolves.toEqual({ type: "page", envelope });
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has(HEADER_DEVTOOLS)).toBe(false);
  });

  it.each([
    ["oversized", "A".repeat(MAX_DEVTOOLS_TRACE_HEADER_CHARS + 1)],
    ["invalid base64url", "not+base64url"],
    ["unsupported protocol", encode({ ...trace, protocol: "fluxfast-devtools/2" })],
    ["unsafe fields", encode({ ...trace, cookie: "secret" })],
  ])(
    "ignores %s diagnostics without changing the page", async (_label, encoded) => {
      await expect(fetchFluxInitialPage({ backendUrl, path: "/", diagnostics: true, fetch: vi.fn().mockResolvedValue(response(envelope, { headers: { [HEADER_DEVTOOLS_TRACE]: encoded } })) })).resolves.toEqual({ type: "page", envelope });
    }
  );
});
