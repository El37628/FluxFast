import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFluxTransportProxy } from "../src/server/index.js";

const backendUrl = "http://127.0.0.1:8000";
const request = (init?: RequestInit) => new Request(
  "https://app.example/fluxfast/transport/ignored?tag=sea+view&tag=suite&empty=",
  { ...init, headers: { "x-fluxfast": "1", ...init?.headers } }
);
const unavailable = { error: {
  code: "transport_unavailable", message: "FluxFast backend is unavailable",
} };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  return "http://127.0.0.1:" + address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe("framework-neutral transport proxy", () => {
  it("uses native HTTP while keeping an external redirect manual and preserving cookies", async () => {
    const externalRequests = vi.fn();
    const external = createServer((_request, response) => { externalRequests(); response.end("external"); });
    const externalUrl = await listen(external);
    const received: unknown[] = [];
    const backend = createServer((incoming, response) => {
      received.push({ url: incoming.url, cookie: incoming.headers.cookie, method: incoming.method });
      response.writeHead(307, {
        location: externalUrl + "/login",
        "set-cookie": ["first=1; Path=/; HttpOnly", "second=2; Path=/; SameSite=Lax"],
      });
      response.end();
    });
    try {
      const proxy = createFluxTransportProxy({ backendUrl: await listen(backend) });
      const response = await proxy(request({ headers: { cookie: "session=example" } }), "/rooms/a%2Fb");
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(externalUrl + "/login");
      expect(response.headers.getSetCookie()).toEqual([
        "first=1; Path=/; HttpOnly", "second=2; Path=/; SameSite=Lax",
      ]);
      expect(received).toEqual([{
        url: "/rooms/a%2Fb?tag=sea+view&tag=suite&empty=", cookie: "session=example", method: "GET",
      }]);
      expect(externalRequests).not.toHaveBeenCalled();
      await response.body?.cancel();
    } finally {
      await Promise.all([close(backend), close(external)]);
    }
  });

  it.each([undefined, "", "0", "true", "1, 1"])(
    "returns a non-cacheable empty 404 for marker %s before inspecting configuration or path",
    async marker => {
      const fetchMock = vi.fn();
      const options = {
        get backendUrl(): string { throw new Error("Backend configuration must not be inspected"); },
        fetch: fetchMock,
      };
      const headers = marker === undefined ? {} : { "x-fluxfast": marker };
      const response = await createFluxTransportProxy(options)(
        new Request("https://app.example/", { headers }), "//evil.example/"
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("streams native HTTP SSE and aborts its upstream connection after the response starts", async () => {
    let upstream!: import("node:http").ServerResponse;
    const disconnected = vi.fn();
    const backend = createServer((_incoming, response) => {
      upstream = response;
      response.once("close", disconnected);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      response.write(": heartbeat\n\n");
    });
    try {
      const abort = new AbortController();
      const proxy = createFluxTransportProxy({ backendUrl: await listen(backend) });
      const response = await proxy(request({ signal: abort.signal }), "/live");
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
      upstream.write('event: fluxfast\ndata: {"type":"ready"}\n\n');
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        'event: fluxfast\ndata: {"type":"ready"}\n\n'
      );
      const abortedRead = reader.read();
      const rejection = expect(abortedRead).rejects.toMatchObject({ name: "AbortError" });
      abort.abort();
      await rejection;
      await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
      reader.releaseLock();
    } finally { await close(backend); }
  });

  it.each([
    "", "rooms", "//evil.example/rooms", "https://evil.example/rooms", "/\\evil.example",
    "/rooms\nprivate", "/rooms\tprivate", "/rooms private", "/rooms\u0000private",
    "/rooms\u007fprivate", "/.", "/..", "/rooms/../admin", "/rooms/./admin",
    "/%2e%2e/admin", "/.%2e/admin", "/%2E./admin", "/%2e/admin",
    "/rooms?override=1", "/rooms#fragment", "/bad%encoding",
  ])("rejects unsafe pathname %s before any backend fetch", async pathname => {
    const fetchMock = vi.fn();
    const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(request(), pathname);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: {
      code: "invalid_transport_path", message: "Invalid FluxFast path",
    } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["/", "/rooms/", "/rooms/a%2Fb/sea%20view", "/rooms/%252e%252e"])(
    "retains backend prefixes and the exact request query for %s",
    async pathname => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const incoming = request();
      const response = await createFluxTransportProxy({ backendUrl: backendUrl + "/api/", fetch: fetchMock })(incoming, pathname);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        backendUrl + "/api" + pathname + "?tag=sea+view&tag=suite&empty=",
        expect.objectContaining({
          method: "GET", body: undefined, cache: "no-store", redirect: "manual", signal: incoming.signal,
        })
      );
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    }
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])("preserves binary %s mutation bodies", async method => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const fetchMock = vi.fn().mockResolvedValue(new Response("accepted", {
      status: 202, statusText: "Accepted", headers: { "content-type": "text/plain" },
    }));
    const incoming = request({
      method, body: bytes,
      headers: { "content-type": "application/octet-stream", "x-csrf-token": "example-csrf" },
    });
    const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(incoming, "/rooms");
    const options = fetchMock.mock.calls[0][1];
    expect(options.method).toBe(method);
    expect(new Uint8Array(options.body)).toEqual(bytes);
    expect(new Headers(options.headers).get("content-type")).toBe("application/octet-stream");
    expect(new Headers(options.headers).get("x-csrf-token")).toBe("example-csrf");
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted");
    expect(await response.text()).toBe("accepted");
  });

  it("does not buffer a GET or HEAD request body", async () => {
    for (const method of ["GET", "HEAD"]) {
      const incoming = request({ method });
      const bodyRead = vi.spyOn(incoming, "arrayBuffer");
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(incoming, "/rooms");
      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
      expect(bodyRead).not.toHaveBeenCalled();
    }
  });

  it("retains the native request-body read failure rather than hiding it as an upstream error", async () => {
    const failure = new Error("body-reader-failed");
    const incoming = request({ method: "POST", body: "example" });
    vi.spyOn(incoming, "arrayBuffer").mockRejectedValueOnce(failure);
    const fetchMock = vi.fn();
    await expect(createFluxTransportProxy({ backendUrl, fetch: fetchMock })(incoming, "/rooms")).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the shared bidirectional hop-header boundary without losing end-to-end fields", async () => {
    const hop = Object.fromEntries([
      "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
      "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    ].map(name => [name, "example"]));
    const upstreamHeaders = new Headers({
      ...hop, connection: "X-Response-Hop, bad field", "x-response-hop": "discard",
      "x-fluxfast-devtools-trace": "safe-trace", "server-timing": "resources;dur=1",
      "x-fluxfast-resources-sent": "1", vary: "X-FluxFast", "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform", "x-accel-buffering": "no",
    });
    upstreamHeaders.append("set-cookie", "first=1; HttpOnly");
    upstreamHeaders.append("set-cookie", "second=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    const fetchMock = vi.fn().mockResolvedValue(new Response("stream", { headers: upstreamHeaders }));
    const incoming = request({ headers: {
      ...hop, connection: "X-Request-Hop, Authorization, bad field", "x-request-hop": "discard",
      authorization: "Bearer discarded", cookie: "session=example", "x-csrf-token": "example-csrf",
      "accept-encoding": "gzip", "x-fluxfast-known": "known", "x-fluxfast-only": "rooms",
      "x-fluxfast-capabilities": "deferred-resources,live-resources", "x-fluxfast-live": "1",
      "x-fluxfast-live-keys": "rooms", "x-fluxfast-client-id": "ff_example",
    } });
    const original = Object.fromEntries(incoming.headers);
    const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(incoming, "/rooms");
    const forwarded = new Headers(fetchMock.mock.calls[0][1].headers);
    for (const name of Object.keys(hop)) {
      expect(forwarded.get(name), name).toBeNull();
      expect(response.headers.get(name), name).toBeNull();
    }
    for (const name of ["authorization", "x-request-hop", "accept-encoding"]) expect(forwarded.get(name)).toBeNull();
    expect(response.headers.get("x-response-hop")).toBeNull();
    for (const name of [
      "cookie", "x-csrf-token", "x-fluxfast-known", "x-fluxfast-only", "x-fluxfast-capabilities",
      "x-fluxfast-live", "x-fluxfast-live-keys", "x-fluxfast-client-id",
    ]) expect(forwarded.get(name)).toBe(incoming.headers.get(name));
    for (const name of [
      "x-fluxfast-devtools-trace", "server-timing", "x-fluxfast-resources-sent", "vary",
      "content-type", "cache-control", "x-accel-buffering",
    ]) expect(response.headers.get(name)).toBe(upstreamHeaders.get(name));
    expect(response.headers.getSetCookie()).toEqual(upstreamHeaders.getSetCookie());
    expect(Object.fromEntries(incoming.headers)).toEqual(original);
    expect(await response.text()).toBe("stream");
  });

  it("returns an open SSE stream immediately, forwards incremental bytes, and propagates cancellation", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(encoder.encode(": heartbeat\n\n")); },
      cancel,
    });
    const upstream = new Response(stream, { headers: {
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no",
    } });
    const fetchMock = vi.fn().mockResolvedValue(upstream);
    const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(request(), "/live");
    expect(response.body).toBe(upstream.body);
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ done: false, value: encoder.encode(": heartbeat\n\n") });
    controller.enqueue(encoder.encode('event: fluxfast\ndata: {"type":"ready"}\n\n'));
    expect(await reader.read()).toEqual({
      done: false, value: encoder.encode('event: fluxfast\ndata: {"type":"ready"}\n\n'),
    });
    await reader.cancel("browser-disconnected");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("browser-disconnected");
  });

  it("passes the identical Request signal to pending upstream work and redacts abort errors", async () => {
    const abort = new AbortController();
    const incoming = request({ signal: abort.signal });
    const fetchMock = vi.fn((_input: RequestInfo | URL, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("private abort details")), { once: true });
      })
    );
    const pending = createFluxTransportProxy({ backendUrl, fetch: fetchMock })(incoming, "/rooms");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(incoming.signal);
    abort.abort();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(unavailable);
  });

  it.each([301, 302, 303, 307, 308])("returns HTTP %s redirects without following or rewriting them", async status => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status, headers: { location: "https://external.example/login?next=%2Frooms" },
    }));
    const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(request(), "/rooms");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBe("https://external.example/login?next=%2Frooms");
  });

  it.each([400, 404, 409, 422, 500])("keeps HTTP %s backend error bytes instead of reinterpreting envelopes", async status => {
    const bytes = '{"detail":[{"loc":["body","name"],"msg":"required"}]}';
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, {
      status, headers: { "content-type": "application/json" },
    }));
    const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(request(), "/rooms");
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(bytes);
  });

  it.each([
    "not-a-url", "file:///private", "http://user:secret@private.example:8000",
    "http://private.example:8000?secret=value", "http://private.example:8000#secret",
  ])("rejects invalid backend configuration without logging or fetching %s", async backendUrl => {
    const fetchMock = vi.fn();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(request(), "/rooms");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(unavailable);
      expect(fetchMock).not.toHaveBeenCalled();
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { for (const log of logs) log.mockRestore(); }
  });

  it("does not expose or log native fetch failures containing credentials and private addresses", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("cookie=session-secret authorization=Bearer secret http://private.example"));
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const response = await createFluxTransportProxy({ backendUrl, fetch: fetchMock })(request(), "/rooms");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(unavailable);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { for (const log of logs) log.mockRestore(); }
  });

  it("uses explicit options rather than adapter environment, and captures the default fetch", async () => {
    vi.stubEnv("FLUXFAST_BACKEND_URL", "http://environment.example:8123");
    const native = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", native);
    const proxy = createFluxTransportProxy({ backendUrl });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Default fetch changed after construction"); }));
    await proxy(request(), "/rooms");
    expect(native.mock.calls[0][0]).toBe(backendUrl + "/rooms?tag=sea+view&tag=suite&empty=");
  });
});
