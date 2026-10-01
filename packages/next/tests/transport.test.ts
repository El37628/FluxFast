import { afterEach, describe, expect, it, vi } from "vitest";
import { createFluxTransportHandler } from "../src/transport";

function context(path?: string[]) {
  return { params: Promise.resolve({ path }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production runtime transport handler", () => {
  it("removes Connection-nominated headers in both proxy directions", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", {
      headers: {
        connection: "X-Response-Hop",
        "x-response-hop": "must-not-forward",
        "x-response-end-to-end": "retained",
      },
    }));
    const handler = createFluxTransportHandler({ backendUrl: "http://127.0.0.1:8123", fetch: fetchMock });
    const response = await handler(new Request("https://app.example/fluxfast/transport/", {
      headers: {
        "x-fluxfast": "1",
        connection: "X-Request-Hop, Authorization",
        "x-request-hop": "must-not-forward",
        authorization: "must-not-forward",
        "x-request-end-to-end": "retained",
      },
    }), context());
    const forwarded = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(forwarded.get("connection")).toBeNull();
    expect(forwarded.get("x-request-hop")).toBeNull();
    expect(forwarded.get("authorization")).toBeNull();
    expect(forwarded.get("x-request-end-to-end")).toBe("retained");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("x-response-hop")).toBeNull();
    expect(response.headers.get("x-response-end-to-end")).toBe("retained");
    expect(await response.text()).toBe("ok");
  });

  it("resolves the private backend per request and preserves path and query", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ protocol: "fluxfast/1" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    ));
    const handler = createFluxTransportHandler({
      backendUrl: "http://127.0.0.1:43123",
      fetch: fetchMock,
    });

    const response = await handler(
      new Request("https://app.example/fluxfast/transport/hotels/101?tag=sea", {
        headers: {
          authorization: "Bearer opaque",
          "x-fluxfast": "1",
        },
      }),
      context(["hotels", "101"])
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/hotels/101?tag=sea",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        redirect: "manual",
      })
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer opaque");
    expect(new Headers(options?.headers).get("host")).toBeNull();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocol: "fluxfast/1" });
  });

  it("forwards mutation bodies without exposing the private origin", async () => {
    const fetchMock = vi.fn(async () => new Response("updated", {
      status: 202,
      headers: { "content-type": "text/plain" },
    }));
    const handler = createFluxTransportHandler({
      backendUrl: "http://backend.internal:8123",
      fetch: fetchMock,
    });
    const response = await handler(
      new Request("https://app.example/fluxfast/transport/rooms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fluxfast": "1",
        },
        body: JSON.stringify({ name: "Sky Suite" }),
      }),
      context(["rooms"])
    );

    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(new TextDecoder().decode(options?.body as ArrayBuffer)).toBe(
      JSON.stringify({ name: "Sky Suite" })
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("updated");
  });

  it("keeps streaming upstream bodies for Live Resources", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: ready\n\n"));
        controller.close();
      },
    });
    const handler = createFluxTransportHandler({
      backendUrl: "http://127.0.0.1:8123",
      fetch: vi.fn(async () => new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      })),
    });

    const response = await handler(
      new Request("https://app.example/fluxfast/transport/live", {
        headers: { "x-fluxfast": "1" },
      }),
      context(["live"])
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: ready\n\n");
  });

  it("delivers an open live stream incrementally and propagates downstream cancellation", async () => {
    const cancelled = vi.fn();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      },
      cancel: cancelled,
    });
    const handler = createFluxTransportHandler({
      backendUrl: "http://127.0.0.1:8123",
      fetch: vi.fn(async () => new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      })),
    });
    const response = await handler(new Request("https://app.example/fluxfast/transport/rooms", {
      headers: { "x-fluxfast": "1", "x-fluxfast-live": "1" },
    }), context(["rooms"]));
    expect(response.body).not.toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const initial = await reader.read();
    expect(initial.done).toBe(false);
    expect(new TextDecoder().decode(initial.value)).toBe(": heartbeat\n\n");
    controller.enqueue(encoder.encode("event: fluxfast\ndata: {\"type\":\"ready\"}\n\n"));
    const next = await reader.read();
    expect(next.done).toBe(false);
    expect(new TextDecoder().decode(next.value)).toBe(
      "event: fluxfast\ndata: {\"type\":\"ready\"}\n\n"
    );
    await reader.cancel("browser-disconnected");
    expect(cancelled).toHaveBeenCalledExactlyOnceWith("browser-disconnected");
  });

  it("passes the request signal upstream and aborts pending transport work", async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn((_url: RequestInfo | URL, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("aborted private request")), {
          once: true,
        });
      })
    );
    const handler = createFluxTransportHandler({ backendUrl: "http://127.0.0.1:8123", fetch: fetchMock });
    const request = new Request("https://app.example/fluxfast/transport/rooms", {
      signal: abort.signal,
      headers: { "x-fluxfast": "1" },
    });
    const pending = handler(request, context(["rooms"]));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(request.signal);
    abort.abort();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: {
      code: "transport_unavailable",
      message: "FluxFast backend is unavailable",
    } });
  });

  it("removes every standard hop header while preserving end-to-end metadata", async () => {
    const hopNames = [
      "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
      "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    ];
    const hopHeaders = Object.fromEntries(hopNames.map(name => [name, "test-only"]));
    const fetchMock = vi.fn(async () => new Response("ok", { headers: {
      ...hopHeaders,
      "x-fluxfast-devtools-trace": "safe-trace",
      "x-response-end-to-end": "retained",
    } }));
    const handler = createFluxTransportHandler({ backendUrl: "http://127.0.0.1:8123", fetch: fetchMock });
    const response = await handler(new Request("https://app.example/fluxfast/transport/rooms", {
      headers: {
        ...hopHeaders,
        "x-fluxfast": "1",
        "accept-encoding": "gzip",
        cookie: "session=test-only",
        authorization: "Bearer test-only",
        "x-fluxfast-only": "rooms",
      },
    }), context(["rooms"]));
    const forwarded = new Headers(fetchMock.mock.calls[0][1].headers);
    for (const name of hopNames) {
      expect(forwarded.get(name), name).toBeNull();
      expect(response.headers.get(name), name).toBeNull();
    }
    expect(forwarded.get("accept-encoding")).toBeNull();
    expect(forwarded.get("cookie")).toBe("session=test-only");
    expect(forwarded.get("authorization")).toBe("Bearer test-only");
    expect(forwarded.get("x-fluxfast-only")).toBe("rooms");
    expect(response.headers.get("x-response-end-to-end")).toBe("retained");
    expect(response.headers.get("x-fluxfast-devtools-trace")).toBe("safe-trace");
    expect(await response.text()).toBe("ok");
  });

  it("resolves supervisor backend changes after the handler has been created", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const handler = createFluxTransportHandler({ fetch: fetchMock });
    for (const port of [8123, 8124]) {
      vi.stubEnv("FLUXFAST_BACKEND_URL", `http://127.0.0.1:${port}`);
      const response = await handler(new Request("https://app.example/fluxfast/transport/?tag=a&tag=b", {
        method: "HEAD",
        headers: { "x-fluxfast": "1" },
      }), { params: {} });
      expect(response.status).toBe(204);
      expect(fetchMock).toHaveBeenLastCalledWith(
        `http://127.0.0.1:${port}/?tag=a&tag=b`,
        expect.objectContaining({ method: "HEAD", body: undefined, redirect: "manual", cache: "no-store" })
      );
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "preserves binary %s bodies and safely encodes route segments",
    async method => {
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
      const handler = createFluxTransportHandler({ backendUrl: "http://127.0.0.1:8123", fetch: fetchMock });
      await handler(new Request("https://app.example/fluxfast/transport/ignored?tag=sea+view&tag=suite", {
        method,
        headers: { "x-fluxfast": "1", "content-type": "application/octet-stream" },
        body: bytes,
      }), { params: { path: ["rooms", "a/b", "sea view"] } });
      const [target, options] = fetchMock.mock.calls[0];
      expect(target).toBe("http://127.0.0.1:8123/rooms/a%2Fb/sea%20view?tag=sea+view&tag=suite");
      expect(options.method).toBe(method);
      expect(new Uint8Array(options.body as ArrayBuffer)).toEqual(bytes);
      expect(new Headers(options.headers).get("content-type")).toBe("application/octet-stream");
    }
  );

  it("returns redirects untouched without following their destinations", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 307,
      statusText: "Temporary Redirect",
      headers: { location: "https://external.example/login" },
    }));
    const handler = createFluxTransportHandler({ backendUrl: "http://127.0.0.1:8123", fetch: fetchMock });
    const response = await handler(new Request("https://app.example/fluxfast/transport/rooms", {
      headers: { "x-fluxfast": "1" },
    }), context(["rooms"]));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    expect(response.status).toBe(307);
    expect(response.statusText).toBe("Temporary Redirect");
    expect(response.headers.get("location")).toBe("https://external.example/login");
  });

  it("rejects non-protocol and unsafe requests without contacting the backend", async () => {
    const fetchMock = vi.fn();
    const handler = createFluxTransportHandler({ fetch: fetchMock });

    const ordinary = await handler(
      new Request("https://app.example/fluxfast/transport/rooms"),
      context(["rooms"])
    );
    const unsafe = await handler(
      new Request("https://app.example/fluxfast/transport/unsafe", {
        headers: { "x-fluxfast": "1" },
      }),
      context(["..", "unsafe"])
    );

    expect(ordinary.status).toBe(404);
    expect(unsafe.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts private transport failures", async () => {
    const handler = createFluxTransportHandler({
      backendUrl: "http://user:secret@private.invalid:8123",
      fetch: vi.fn(async () => {
        throw new Error("connect http://user:secret@private.invalid:8123");
      }),
    });

    const response = await handler(
      new Request("https://app.example/fluxfast/transport/rooms", {
        headers: { "x-fluxfast": "1" },
      }),
      context(["rooms"])
    );
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).toContain("FluxFast backend is unavailable");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("private.invalid");
  });
});
