import { describe, expect, it, vi } from "vitest";
import { createFluxTransportHandler } from "../src/transport";

function context(path?: string[]) {
  return { params: Promise.resolve({ path }) };
}

describe("production runtime transport handler", () => {
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
      new Request("https://app.example/_fluxfast/transport/hotels/101?tag=sea", {
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
      new Request("https://app.example/_fluxfast/transport/rooms", {
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
      new Request("https://app.example/_fluxfast/transport/live", {
        headers: { "x-fluxfast": "1" },
      }),
      context(["live"])
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: ready\n\n");
  });

  it("rejects non-protocol and unsafe requests without contacting the backend", async () => {
    const fetchMock = vi.fn();
    const handler = createFluxTransportHandler({ fetch: fetchMock });

    const ordinary = await handler(
      new Request("https://app.example/_fluxfast/transport/rooms"),
      context(["rooms"])
    );
    const unsafe = await handler(
      new Request("https://app.example/_fluxfast/transport/unsafe", {
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
      new Request("https://app.example/_fluxfast/transport/rooms", {
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
