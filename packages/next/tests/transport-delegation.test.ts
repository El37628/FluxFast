import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFluxTransportHandler } from "../src/transport.js";

const { createProxy, proxy, unexpectedFetch } = vi.hoisted(() => ({
  createProxy: vi.fn(),
  proxy: vi.fn(),
  unexpectedFetch: vi.fn(() => { throw new Error("Adapter bypassed Core proxy"); }),
}));

vi.mock("@fluxfast/core/server", async importOriginal => ({
  ...await importOriginal<typeof import("@fluxfast/core/server")>(),
  createFluxTransportProxy: createProxy,
}));

beforeEach(() => {
  createProxy.mockReset().mockReturnValue(proxy);
  proxy.mockReset().mockImplementation(async () => new Response("core-response", { status: 202 }));
  vi.stubGlobal("fetch", unexpectedFetch);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Next transport delegates HTTP mechanics to Core", () => {
  it("passes the original request and encoded catch-all pathname, leaving query handling to Core", async () => {
    const fetchImplementation = vi.fn();
    const handler = createFluxTransportHandler({ backendUrl: "http://127.0.0.1:8123/", fetch: fetchImplementation });
    const request = new Request("https://app.example/fluxfast/transport/ignored?tag=a&tag=b", {
      method: "POST", headers: { "x-fluxfast": "1", "content-type": "application/json" }, body: '{"name":"example"}',
    });
    const bodyRead = vi.spyOn(request, "arrayBuffer");
    const response = await handler(request, { params: Promise.resolve({ path: ["rooms", "a/b", "sea view"] }) });
    expect(createProxy).toHaveBeenCalledOnce();
    const options = createProxy.mock.calls[0][0];
    expect(options.backendUrl).toBe("http://127.0.0.1:8123");
    expect(options.fetch).toBe(fetchImplementation);
    expect(proxy).toHaveBeenCalledExactlyOnceWith(request, "/rooms/a%2Fb/sea%20view");
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("core-response");
    expect(bodyRead).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it.each([undefined, []])("maps empty Next catch-all params %s to the root", async path => {
    const handler = createFluxTransportHandler();
    const request = new Request("https://app.example/fluxfast/transport/", { headers: { "x-fluxfast": "1" } });
    await handler(request, { params: { path } });
    expect(proxy).toHaveBeenCalledExactlyOnceWith(request, "/");
  });

  it.each([
    { segments: ["."] }, { segments: [".."] }, { segments: [""] },
    { segments: ["rooms", "..", "admin"] },
  ])(
    "passes invalid Next segments $segments to Core for its authoritative rejection",
    async ({ segments }) => {
      const handler = createFluxTransportHandler();
      const request = new Request("https://app.example/fluxfast/transport/", { headers: { "x-fluxfast": "1" } });
      await handler(request, { params: { path: segments } });
      expect(proxy).toHaveBeenCalledExactlyOnceWith(request, "");
    }
  );

  it("keeps backend environment resolution lazy and observes supervisor changes per request", async () => {
    const destinations: string[] = [];
    createProxy.mockImplementation(options => async () => {
      destinations.push(options.backendUrl);
      return new Response(null, { status: 204 });
    });
    const handler = createFluxTransportHandler();
    for (const port of [8123, 8124]) {
      vi.stubEnv("FLUXFAST_BACKEND_URL", "http://127.0.0.1:" + port);
      await handler(new Request("https://app.example/fluxfast/transport/", {
        headers: { "x-fluxfast": "1" },
      }), { params: {} });
    }
    expect(destinations).toEqual(["http://127.0.0.1:8123", "http://127.0.0.1:8124"]);
    expect(createProxy).toHaveBeenCalledOnce();
  });

  it("preserves explicit backend priority and captures the initial fetch implementation", async () => {
    vi.stubEnv("FLUXFAST_BACKEND_URL", "http://127.0.0.1:8124");
    const handler = createFluxTransportHandler({ backendUrl: "http://127.0.0.1:9000" });
    vi.stubGlobal("fetch", vi.fn());
    await handler(new Request("https://app.example/", { headers: { "x-fluxfast": "1" } }), { params: {} });
    expect(createProxy.mock.calls[0][0].backendUrl).toBe("http://127.0.0.1:9000");
    expect(createProxy.mock.calls[0][0].fetch).toBe(unexpectedFetch);
  });
});
