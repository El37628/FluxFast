import React from "react";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_CAPABILITIES, serializeCapabilities, TransportError } from "@fluxfast/core";
import {
  buildFluxPath,
  createFluxNextPage,
  fetchInitialEnvelope,
} from "../src/server";
import { resolveInternalDestination } from "../src/link";

const { headersMock, notFoundMock } = vi.hoisted(() => ({
  headersMock: vi.fn(async () => new Headers()),
  notFoundMock: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/headers", () => ({ headers: headersMock }));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP test server");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

const initialEnvelope = {
  protocol: "fluxfast/1",
  page: { component: "home/index", url: "/" },
  resources: {},
};

describe("initial SSR redirect boundary", () => {
  it.each([301, 302, 303, 307, 308])(
    "does not contact a different origin through an HTTP %s redirect",
    async status => {
      const targetRequests = vi.fn();
      const target = createServer((_request, response) => {
        targetRequests();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(initialEnvelope));
      });
      const targetUrl = await listen(target);
      const backend = createServer((_request, response) => {
        response.writeHead(status, { location: `${targetUrl}/redirected` });
        response.end();
      });
      try {
        const backendUrl = await listen(backend);
        await expect(fetchInitialEnvelope({
          backendUrl,
          path: "/",
          headers: { authorization: "Bearer test-only", cookie: "session=test-only" },
        })).rejects.toThrow(/redirect/i);
        expect(targetRequests).not.toHaveBeenCalled();
      } finally {
        await Promise.all([close(backend), close(target)]);
      }
    }
  );

  it.each([301, 302, 303, 307, 308])(
    "preserves same-origin HTTP %s redirects and forwarded authentication",
    async status => {
      const requests: { url: string | undefined; authorization: string | undefined }[] = [];
      const backend = createServer((request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        if (request.url === "/canonical/") {
          response.writeHead(status, { location: "../canonical?ready=1" });
          response.end();
        } else {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(initialEnvelope));
        }
      });
      try {
        const backendUrl = await listen(backend);
        await expect(fetchInitialEnvelope({
          backendUrl, path: "/canonical/", headers: { authorization: "Bearer test-only" },
        })).resolves.toEqual(initialEnvelope);
        expect(requests).toEqual([
          { url: "/canonical/", authorization: "Bearer test-only" },
          { url: "/canonical?ready=1", authorization: "Bearer test-only" },
        ]);
      } finally {
        await close(backend);
      }
    }
  );

  it("bounds redirect loops", async () => {
    let requests = 0;
    const backend = createServer((_request, response) => {
      requests++;
      response.writeHead(307, { location: "/loop" });
      response.end();
    });
    try {
      const backendUrl = await listen(backend);
      await expect(fetchInitialEnvelope({ backendUrl, path: "/loop" }))
        .rejects.toThrow(/redirect/i);
      expect(requests).toBeLessThanOrEqual(21);
    } finally {
      await close(backend);
    }
  });

  it.each([
    "http://test-only:secret@127.0.0.1:8000/",
    "http://[invalid",
    "file:///etc/passwd",
    "//other.example/private",
  ])("rejects an unsafe redirect target without forwarding or reflecting it", async location => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", {
      status: 307, headers: { location },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/" })
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toMatch(/redirect/i);
    expect((error as Error).message).not.toContain(location);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["/canonical", "https://other.example/private"])(
    "cancels a discarded redirect body before following or rejecting its target",
    async location => {
      const cancelled = vi.fn();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), {
          status: 307, headers: { location },
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify(initialEnvelope)));
      vi.stubGlobal("fetch", fetchMock);
      const result = fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/" });
      if (location.startsWith("/")) {
        await expect(result).resolves.toEqual(initialEnvelope);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } else {
        await expect(result).rejects.toBeInstanceOf(TransportError);
        expect(fetchMock).toHaveBeenCalledOnce();
      }
      expect(cancelled).toHaveBeenCalledOnce();
    }
  );
});

describe("Next adapter paths", () => {
  it("forwards only default and explicitly allowed safe SSR headers", async () => {
    headersMock.mockResolvedValueOnce(new Headers({
      cookie: "session=test-only",
      authorization: "Bearer test-only",
      "accept-language": "en",
      "user-agent": "test-only",
      "x-tenant": "declared-custom-value",
      "x-hop": "must-not-forward",
      "x-private-ignored": "must-not-forward",
      "x-fluxfast-known": "must-not-forward",
      host: "attacker.example",
      connection: "keep-alive, X-Hop",
      "proxy-authorization": "must-not-forward",
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(initialEnvelope)));
    vi.stubGlobal("fetch", fetchMock);
    const page = createFluxNextPage({
      backendUrl: "http://127.0.0.1:8000",
      application: () => null,
      forwardHeaders: ["X-Tenant", "X-Hop", "HOST", "CONNECTION", "Proxy-Authorization", "Invalid Header"],
    });
    await page({ params: {} });
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers).toMatchObject({
      cookie: "session=test-only",
      authorization: "Bearer test-only",
      "accept-language": "en",
      "user-agent": "test-only",
      "x-tenant": "declared-custom-value",
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
    });
    for (const name of ["host", "connection", "x-hop", "proxy-authorization", "invalid header", "x-private-ignored", "x-fluxfast-known"]) {
      expect(headers).not.toHaveProperty(name);
    }
  });

  it("advertises capabilities during the initial SSR request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocol: "fluxfast/1",
      page: { component: "home/index", url: "/" },
      resources: {},
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/" });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      [HEADER_CAPABILITIES]: serializeCapabilities(),
    });
  });

  it("reconstructs catch-all paths and repeated search parameters", () => {
    expect(buildFluxPath(["rooms", "101"], {
      status: "available",
      tag: ["sea view", "suite"],
    })).toBe("/rooms/101?status=available&tag=sea+view&tag=suite");
  });

  it("handles the optional catch-all root", () => {
    expect(buildFluxPath(undefined)).toBe("/");
  });

  it("uses a lazy not-found child after a completed timing anchor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "Not Found" }),
      {
        status: 404,
        headers: { "content-type": "application/json" },
      }
    )));
    const page = createFluxNextPage({
      backendUrl: "http://127.0.0.1:8000",
      application: () => null,
    });

    const result = await page({ params: { flux: ["missing"] } });

    expect(React.isValidElement(result)).toBe(true);
    expect(notFoundMock).not.toHaveBeenCalled();
    const children = React.Children.toArray(
      (result.props as { children: React.ReactNode }).children
    ) as React.ReactElement[];
    expect(children).toHaveLength(2);
    const TimingAnchor = children[0]?.type as () => null;
    expect(TimingAnchor()).toBeNull();
    const NotFoundBoundary = children[1]?.type as unknown as {
      $$typeof: symbol;
      _init: (payload: unknown) => unknown;
      _payload: unknown;
    };
    expect(NotFoundBoundary.$$typeof).toBe(Symbol.for("react.lazy"));
    expect(() => NotFoundBoundary._init(NotFoundBoundary._payload)).toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("preserves fetchInitialEnvelope not-found behavior", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "Not Found" }),
      {
        status: 404,
        headers: { "content-type": "application/json" },
      }
    )));

    await expect(fetchInitialEnvelope({
      backendUrl: "http://127.0.0.1:8000",
      path: "/missing",
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("only normalizes same-origin application links", () => {
    const current = "https://app.example/dashboard";
    expect(resolveInternalDestination("/rooms?page=2", current)).toBe("/rooms?page=2");
    expect(resolveInternalDestination("rooms", current)).toBe("/rooms");
    expect(resolveInternalDestination("https://elsewhere.example/rooms", current)).toBeNull();
    expect(resolveInternalDestination("mailto:team@example.com", current)).toBeNull();
  });
});
