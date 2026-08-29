import { describe, expect, it } from "vitest";
import { PageCache } from "../src/cache";
import { ResourceStore } from "../src/store";

describe("PageCache resource manifests", () => {
  it("tracks only the page-owned resources from an explicit manifest", () => {
    const resources = new ResourceStore();
    resources.set({ key: "auth", version: "a1", value: { id: 1 } });
    resources.set({ key: "summary", version: "s1", value: { count: 1 } });
    resources.set({ key: "rooms", version: "r1", value: [] });
    const cache = new PageCache();

    cache.set(
      { component: "dashboard/index", url: "/dashboard" },
      { summary: "s1" },
      {
        resourceKeys: ["summary", "analytics"],
        pendingDeferred: ["analytics"],
      }
    );
    resources.invalidate("rooms");

    expect(cache.getValid("/dashboard", resources)).toEqual({
      component: "dashboard/index",
      url: "/dashboard",
      meta: {},
      resources: { summary: "s1" },
      resourceKeys: ["summary", "analytics"],
      pendingDeferred: ["analytics"],
    });
  });

  it("keeps pending deferred resources valid and records them after settlement", () => {
    const resources = new ResourceStore();
    resources.set({ key: "summary", version: "s1", value: { count: 1 } });
    resources.markPending(["analytics"]);
    const cache = new PageCache();
    cache.set(
      { component: "dashboard/index", url: "/dashboard" },
      { summary: "s1" },
      {
        resourceKeys: ["summary", "analytics"],
        pendingDeferred: ["analytics"],
      }
    );

    expect(cache.getValid("/dashboard", resources)?.pendingDeferred)
      .toEqual(["analytics"]);

    resources.set({
      key: "analytics",
      version: "an1",
      value: { revenue: 95_000 },
    });
    cache.settleResources("/dashboard", ["analytics"], resources);

    expect(cache.getValid("/dashboard", resources)).toMatchObject({
      resources: { summary: "s1", analytics: "an1" },
      pendingDeferred: [],
    });
  });

  it("allows settled resource errors but rejects an evicted resolved resource", () => {
    const resources = new ResourceStore();
    resources.set({ key: "summary", version: "s1", value: { count: 1 } });
    resources.setResourceError("activity", {
      type: "ResourceError",
      message: "A deferred resource could not be resolved",
    });
    const cache = new PageCache();
    cache.set(
      { component: "dashboard/index", url: "/dashboard" },
      { summary: "s1" },
      {
        resourceKeys: ["summary", "activity"],
        pendingDeferred: ["activity"],
      }
    );
    cache.settleResources("/dashboard", ["activity"], resources);

    expect(cache.getValid("/dashboard", resources)?.pendingDeferred).toEqual([]);

    resources.invalidate("summary");
    expect(cache.getValid("/dashboard", resources)).toBeUndefined();
  });
});
