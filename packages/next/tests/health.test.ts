import { afterEach, describe, expect, it, vi } from "vitest";
import { createFluxHealthHandler } from "../src/health";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public FluxFast health handler", () => {
  it.each([
    ["healthz", 200, "ok"],
    ["readyz", 200, "ready"],
    ["readyz", 503, "not_ready"],
  ] as const)(
    "proxies a valid %s response without exposing the private origin",
    async (probe, statusCode, status) => {
      const fetchMock = vi.fn(async () => new Response(
        JSON.stringify({ status, private_port: 43123 }),
        {
          status: statusCode,
          headers: { "content-type": "application/json" },
        }
      ));
      vi.stubGlobal("fetch", fetchMock);
      const handler = createFluxHealthHandler({
        backendUrl: "http://127.0.0.1:43123",
      });

      const response = await handler(
        new Request(`https://app.example/_fluxfast/${probe}`)
      );

      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:43123/_fluxfast/${probe}`,
        expect.objectContaining({
          method: "GET",
          cache: "no-store",
          redirect: "manual",
        })
      );
      expect(response.status).toBe(statusCode);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ status });
    }
  );

  it.each([
    new Error("connect ECONNREFUSED 127.0.0.1:43123"),
    new Response(JSON.stringify({ detail: "redis://secret@internal" }), {
      status: 500,
    }),
    new Response(JSON.stringify({ status: "ok", port: 43123 }), {
      status: 503,
    }),
  ])("collapses failures and malformed responses into a minimal 503", async value => {
    const fetchMock = value instanceof Error
      ? vi.fn(async () => { throw value; })
      : vi.fn(async () => value);
    vi.stubGlobal("fetch", fetchMock);
    const handler = createFluxHealthHandler({
      backendUrl: "http://127.0.0.1:43123",
    });

    const response = await handler(
      new Request("https://app.example/_fluxfast/healthz")
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
  });

  it("does not contact the backend for an unsupported reserved probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createFluxHealthHandler({
      backendUrl: "http://127.0.0.1:43123",
    });

    const response = await handler(
      new Request("https://app.example/_fluxfast/details")
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid timeout configuration", () => {
    expect(() => createFluxHealthHandler({ timeoutMs: 0 })).toThrow(
      "timeoutMs must be a positive number"
    );
  });
});
