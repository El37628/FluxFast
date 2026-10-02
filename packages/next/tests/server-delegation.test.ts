import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportError } from "@fluxfast/core";
import { selectFluxForwardHeaders } from "@fluxfast/core/server";
import { createFluxNextPage, fetchInitialEnvelope } from "../src/server.js";

const { coreFetch, incomingHeaders, notFound, unexpectedFetch } = vi.hoisted(() => ({
  coreFetch: vi.fn(),
  incomingHeaders: vi.fn(),
  notFound: vi.fn((): never => { throw new Error("NEXT_NOT_FOUND"); }),
  unexpectedFetch: vi.fn(async () => { throw new Error("Adapter bypassed Core fetch"); }),
}));

vi.mock("next/headers", () => ({ headers: incomingHeaders }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@fluxfast/core/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@fluxfast/core/server")>();
  return {
    ...actual,
    fetchFluxInitialPage: coreFetch,
    selectFluxForwardHeaders: vi.fn(actual.selectFluxForwardHeaders),
  };
});

const envelope = {
  protocol: "fluxfast/1" as const,
  page: { component: "rooms/index", url: "/rooms?tag=a&tag=b" },
  resources: { rooms: { version: "opaque", value: [{ id: 1 }] } },
};

beforeEach(() => {
  coreFetch.mockReset().mockResolvedValue({ type: "page", envelope });
  incomingHeaders.mockReset().mockResolvedValue(new Headers());
  vi.stubGlobal("fetch", unexpectedFetch);
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Next initial SSR delegates to the shared Core server boundary", () => {
  it("keeps the public fetch call and envelope identity while supplying host diagnostics policy", async () => {
    const options = {
      backendUrl: "http://127.0.0.1:8000", path: "/rooms?tag=a&tag=b",
      headers: { cookie: "session=example" },
    };
    await expect(fetchInitialEnvelope(options)).resolves.toBe(envelope);
    expect(coreFetch).toHaveBeenCalledExactlyOnceWith({ ...options, diagnostics: true });
    expect(incomingHeaders).not.toHaveBeenCalled();
    expect(selectFluxForwardHeaders).not.toHaveBeenCalled();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("disables Core diagnostics in production without adding an option to the public Next API", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/" })).resolves.toBe(envelope);
    expect(coreFetch).toHaveBeenCalledExactlyOnceWith({
      backendUrl: "http://127.0.0.1:8000", path: "/", diagnostics: false,
    });
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("translates a shared not-found result into the existing public Next notFound behavior", async () => {
    coreFetch.mockResolvedValueOnce({ type: "not-found" });
    await expect(fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/missing" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    expect(coreFetch).toHaveBeenCalledOnce();
  });

  it("preserves Core transport failures without wrapping or classifying them as not-found", async () => {
    const failure = new TransportError("Backend unavailable", 502);
    coreFetch.mockRejectedValueOnce(failure);
    await expect(fetchInitialEnvelope({ backendUrl: "http://127.0.0.1:8000", path: "/" })).rejects.toBe(failure);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("keeps Next path encoding, incoming headers, application props, and shared header selection", async () => {
    const incoming = new Headers({
      cookie: "session=example", authorization: "Bearer example", "accept-language": "en",
      "user-agent": "example", "x-tenant": "tenant", "x-hop": "discard", "x-unlisted": "discard",
      connection: "keep-alive, x-hop", host: "attacker.example",
    });
    incomingHeaders.mockResolvedValueOnce(incoming);
    const development = {
      initialPath: "/rooms/a%2Fb", initialServerTrace: {
        protocol: "fluxfast-devtools/1", requestId: "ffdev_example", type: "page",
        durationMs: 1, pageMs: 0, resourcesMs: 1, serializeMs: 0, resources: [], truncated: false,
      },
    };
    coreFetch.mockResolvedValueOnce({ type: "page", envelope, development });
    const application = () => null;
    const cache = { maxPages: 8, maxResources: 16 };
    const forwardHeaders = ["X-Tenant", "X-Hop", "HOST", "Connection", "Invalid Header"];
    const page = createFluxNextPage({ application, backendUrl: "http://127.0.0.1:8000/", forwardHeaders, clientUrl: "/", cache });
    const result = await page({
      params: Promise.resolve({ flux: ["rooms", "a/b"] }),
      searchParams: Promise.resolve({ tag: ["sea view", "suite"], empty: "", omitted: undefined }),
    }) as React.ReactElement<Record<string, unknown>>;
    expect(incomingHeaders).toHaveBeenCalledOnce();
    expect(selectFluxForwardHeaders).toHaveBeenCalledExactlyOnceWith(incoming, forwardHeaders);
    expect(coreFetch).toHaveBeenCalledOnce();
    const options = coreFetch.mock.calls[0][0];
    expect(options).toMatchObject({
      backendUrl: "http://127.0.0.1:8000", path: "/rooms/a%2Fb?tag=sea+view&tag=suite&empty=", diagnostics: true,
    });
    expect(Object.fromEntries(new Headers(options.headers))).toEqual({
      cookie: "session=example", authorization: "Bearer example", "accept-language": "en", "user-agent": "example", "x-tenant": "tenant",
    });
    expect(incoming.get("x-hop")).toBe("discard");
    expect(result.type).toBe(application);
    expect(result.props).toEqual({ initialEnvelope: envelope, development, clientUrl: "/", cache });
    expect(result.props.initialEnvelope).toBe(envelope);
    expect(result.props.development).toBe(development);
    expect(notFound).not.toHaveBeenCalled();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("keeps the private backend address in the adapter environment, not Core", async () => {
    vi.stubEnv("FLUXFAST_BACKEND_URL", "http://127.0.0.1:8123/api/");
    const page = createFluxNextPage({ application: () => null });
    await page({ params: {} });
    expect(coreFetch.mock.calls[0][0]).toMatchObject({ backendUrl: "http://127.0.0.1:8123/api", path: "/" });
    expect(selectFluxForwardHeaders).toHaveBeenCalledWith(expect.any(Headers), []);
  });

  it("preserves explicit backend configuration ahead of the supervisor environment", async () => {
    vi.stubEnv("FLUXFAST_BACKEND_URL", "http://127.0.0.1:8123");
    const page = createFluxNextPage({ application: () => null, backendUrl: "http://127.0.0.1:9000" });
    await page({ params: {} });
    expect(coreFetch.mock.calls[0][0].backendUrl).toBe("http://127.0.0.1:9000");
  });

  it("keeps production bootstrap metadata absent when Core diagnostics are disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const page = createFluxNextPage({ application: () => null });
    const result = await page({ params: {} }) as React.ReactElement<Record<string, unknown>>;
    expect(coreFetch.mock.calls[0][0].diagnostics).toBe(false);
    expect(result.props).not.toHaveProperty("development");
  });

  it("preserves the completed timing anchor and lazy RSC boundary for a shared missing page", async () => {
    coreFetch.mockResolvedValueOnce({ type: "not-found" });
    const page = createFluxNextPage({ application: () => null });
    const result = await page({ params: { flux: ["missing"] } });
    expect(result.type).toBe(React.Fragment);
    const children = React.Children.toArray(
      (result.props as { children: React.ReactNode }).children
    ) as React.ReactElement[];
    expect(children).toHaveLength(2);
    expect((children[0].type as () => null)()).toBeNull();
    expect((children[1].type as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.lazy"));
    expect(notFound).not.toHaveBeenCalled();
    expect(coreFetch).toHaveBeenCalledOnce();
  });
});
