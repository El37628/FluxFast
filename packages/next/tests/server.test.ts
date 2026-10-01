import React from "react";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEADER_CAPABILITIES,
  HEADER_DEVTOOLS,
  HEADER_DEVTOOLS_TRACE,
  MAX_DEVTOOLS_TRACE_HEADER_CHARS,
  ProtocolError,
  serializeCapabilities,
  TransportError,
} from "@fluxfast/core";
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
  vi.unstubAllEnvs();
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

function encodeTrace(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function pageTrace(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "fluxfast-devtools/1",
    requestId: "ffdev_0123456789abcdef",
    type: "page",
    durationMs: 4.5,
    pageMs: 1,
    resourcesMs: 2,
    serializeMs: 0.5,
    resources: [],
    truncated: false,
    ...overrides,
  };
}

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
      expect(requests).toBe(21);
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

describe("v1.1 initial SSR baseline", () => {
  it("preserves request mode, authentication, capabilities, and the application bootstrap", async () => {
    headersMock.mockResolvedValueOnce(new Headers({
      cookie: "session=test-only",
      authorization: "Bearer test-only",
      "accept-language": "en-GB",
      "user-agent": "baseline-browser",
      "x-tenant": "test-tenant",
      "x-unlisted": "must-not-forward",
    }));
    const envelope = {
      protocol: "fluxfast/1",
      page: { component: "rooms/show", url: "/rooms/a%2Fb?tag=sea+view&tag=suite&empty=" },
      resources: { rooms: { version: "opaque-version", value: [{ id: 1 }] } },
      resourceKeys: ["rooms", "report"],
      deferred: ["report"],
      live: ["rooms"],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope)));
    vi.stubGlobal("fetch", fetchMock);
    const application = () => null;
    const cache = { maxResources: 128, maxPages: 32 };
    const page = createFluxNextPage({
      application,
      backendUrl: "http://127.0.0.1:8000/",
      clientUrl: "https://app.example",
      forwardHeaders: ["X-Tenant"],
      cache,
    });
    const element = await page({
      params: Promise.resolve({ flux: ["rooms", "a/b"] }),
      searchParams: Promise.resolve({ tag: ["sea view", "suite"], empty: "", omitted: undefined }),
    }) as React.ReactElement;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8000/rooms/a%2Fb?tag=sea+view&tag=suite&empty="
    );
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    const requestHeaders = new Headers(options.headers);
    expect(requestHeaders.get("X-FluxFast-Visit")).toMatch(/^ssr_[a-z0-9]+$/);
    requestHeaders.delete("X-FluxFast-Visit");
    expect(Object.fromEntries(requestHeaders)).toEqual({
      accept: "application/vnd.fluxfast+json",
      authorization: "Bearer test-only",
      cookie: "session=test-only",
      "accept-language": "en-GB",
      "user-agent": "baseline-browser",
      "x-tenant": "test-tenant",
      "x-fluxfast": "1",
      "x-fluxfast-protocol": "1",
      "x-fluxfast-capabilities": "deferred-resources,live-resources",
      "x-fluxfast-devtools": "1",
    });
    expect(element.type).toBe(application);
    expect(element.props).toEqual({ initialEnvelope: envelope, clientUrl: "https://app.example", cache });
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it.each(["", "rooms", "https://other.example/rooms", "//other.example/rooms"])(
    "rejects a non-origin-relative initial path %s before fetching",
    async path => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path }))
        .rejects.toThrow("FluxFast initial paths must be origin-relative");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("allows twenty same-origin redirects and preserves cookies throughout the chain", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => fetchMock.mock.calls.length <= 20
      ? new Response(null, { status: 307, headers: { location: "/canonical" } })
      : new Response(JSON.stringify(initialEnvelope)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchInitialEnvelope({
      backendUrl: "http://127.0.0.1:8000",
      path: "/start",
      headers: { cookie: "session=test-only" },
    })).resolves.toEqual(initialEnvelope);
    expect(fetchMock).toHaveBeenCalledTimes(21);
    for (const [, options] of fetchMock.mock.calls) {
      expect(new Headers(options.headers).get("cookie")).toBe("session=test-only");
      expect(options.redirect).toBe("manual");
    }
  });

  it.each([
    [422, { error: { type: "ValidationError", message: "Request validation failed" } }, "Request validation failed"],
    [403, { detail: "Forbidden" }, "Forbidden"],
    [503, {}, "Failed to fetch initial FluxFast envelope"],
  ] as const)("preserves HTTP %s error classification", async (status, payload, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status })));
    const result = await fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/rooms" })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(TransportError);
    expect(result).toMatchObject({ status, details: payload });
    expect((result as Error).message).toContain(message);
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("classifies non-JSON upstream bodies as transport failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream unavailable", { status: 502 })));
    const result = await fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/rooms" })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(TransportError);
    expect(result).toMatchObject({ status: 502 });
    expect((result as Error).message).toMatch(/parse initial FluxFast response/);
  });

  it("validates a successful envelope before handing it to the application", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...initialEnvelope,
      resources: { rooms: { version: 1, value: [] } },
    }))));
    await expect(fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/rooms" }))
      .rejects.toBeInstanceOf(ProtocolError);
    expect(notFoundMock).not.toHaveBeenCalled();
  });
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
      "x-fluxfast-devtools": "must-not-forward",
      host: "attacker.example",
      connection: "keep-alive, X-Hop",
      "proxy-authorization": "must-not-forward",
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(initialEnvelope)));
    vi.stubGlobal("fetch", fetchMock);
    const page = createFluxNextPage({
      backendUrl: "http://127.0.0.1:8000",
      application: () => null,
      forwardHeaders: ["X-Tenant", "X-Hop", "HOST", "CONNECTION", "Proxy-Authorization", "X-FluxFast-DevTools", "Invalid Header"],
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
    expect(new Headers(headers).get(HEADER_DEVTOOLS)).toBe("1");
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
      [HEADER_DEVTOOLS]: "1",
    });
  });

  it("passes only a validated initial trace and query-free path as development metadata", async () => {
    const trace = pageTrace();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(initialEnvelope),
      {
        headers: {
          "content-type": "application/json",
          [HEADER_DEVTOOLS_TRACE]: encodeTrace(trace),
        },
      }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const page = createFluxNextPage({
      backendUrl: "http://127.0.0.1:8000",
      application: () => null,
    });

    const result = await page({
      params: { flux: ["rooms"] },
      searchParams: { token: "must-not-reach-html" },
    });
    const props = (result as React.ReactElement).props as Record<string, unknown>;

    expect(props.initialEnvelope).toEqual(initialEnvelope);
    expect(props.development).toMatchObject({
      initialPath: "/rooms",
      initialServerTrace: trace,
    });
    expect(JSON.stringify(props.development)).not.toContain("must-not-reach-html");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get(HEADER_DEVTOOLS))
      .toBe("1");
  });

  it("ignores invalid SSR traces without affecting the page", async () => {
    const unsafe = pageTrace({ authorization: "Bearer must-not-reach-html" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(initialEnvelope),
      { headers: { [HEADER_DEVTOOLS_TRACE]: encodeTrace(unsafe) } }
    )));
    const page = createFluxNextPage({
      backendUrl: "http://127.0.0.1:8000",
      application: () => null,
    });

    const result = await page({ params: {} });
    const props = (result as React.ReactElement).props as Record<string, unknown>;

    expect(props.initialEnvelope).toEqual(initialEnvelope);
    expect(props).not.toHaveProperty("development");
  });

  it.each([
    ["oversized", "A".repeat(MAX_DEVTOOLS_TRACE_HEADER_CHARS + 1)],
    ["invalid base64url", "not+base64url"],
    ["invalid JSON", Buffer.from("{").toString("base64url")],
    ["unknown protocol", encodeTrace(pageTrace({
      protocol: "fluxfast-devtools/2",
    }))],
    ["prototype-sensitive payload", encodeTrace(JSON.parse(
      JSON.stringify(pageTrace()).replace(/}$/, ',"__proto__":{"polluted":true}}')
    ))],
  ])("fails closed for a %s SSR trace without affecting the page", async (_label, trace) => {
    delete (Object.prototype as { polluted?: boolean }).polluted;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(initialEnvelope),
      { headers: { [HEADER_DEVTOOLS_TRACE]: trace } }
    )));
    const page = createFluxNextPage({
      backendUrl: "http://127.0.0.1:8000",
      application: () => null,
    });

    const result = await page({ params: {} });
    const props = (result as React.ReactElement).props as Record<string, unknown>;

    expect(props.initialEnvelope).toEqual(initialEnvelope);
    expect(props).not.toHaveProperty("development");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("does not request or serialize SSR diagnostics in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify(initialEnvelope),
      { headers: { [HEADER_DEVTOOLS_TRACE]: encodeTrace(pageTrace()) } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const page = createFluxNextPage({
      backendUrl: "http://127.0.0.1:8000",
      application: () => null,
    });

    const result = await page({ params: {} });
    const props = (result as React.ReactElement).props as Record<string, unknown>;

    expect(new Headers(fetchMock.mock.calls[0][1].headers).get(HEADER_DEVTOOLS))
      .toBeNull();
    expect(props).not.toHaveProperty("development");

    await fetchInitialEnvelope({
      backendUrl: "http://127.0.0.1:8000",
      path: "/",
      headers: { "x-fluxfast-devtools": "1" },
    });
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get(HEADER_DEVTOOLS))
      .toBeNull();
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
