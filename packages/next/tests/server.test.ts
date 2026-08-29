import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_CAPABILITIES, serializeCapabilities } from "@fluxfast/core";
import { buildFluxPath, fetchInitialEnvelope } from "../src/server";
import { resolveInternalDestination } from "../src/link";

afterEach(() => vi.unstubAllGlobals());

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

  it("only normalizes same-origin application links", () => {
    const current = "https://app.example/dashboard";
    expect(resolveInternalDestination("/rooms?page=2", current)).toBe("/rooms?page=2");
    expect(resolveInternalDestination("rooms", current)).toBe("/rooms");
    expect(resolveInternalDestination("https://elsewhere.example/rooms", current)).toBeNull();
    expect(resolveInternalDestination("mailto:team@example.com", current)).toBeNull();
  });
});
