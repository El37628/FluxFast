import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_CAPABILITIES, serializeCapabilities } from "@fluxfast/core";
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

describe("Next adapter paths", () => {
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

  it("resolves a not-found child before interrupting an async page", async () => {
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
    const NotFoundComponent = result.type as () => never;
    expect(() => NotFoundComponent()).toThrow("NEXT_NOT_FOUND");
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
