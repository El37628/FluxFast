import { describe, it, expect, vi } from "vitest";
import { ResourceStore, PageStore } from "../src/store";

describe("ResourceStore", () => {
  it("returns a stable frozen missing-state snapshot", () => {
    const store = new ResourceStore();

    const first = store.getStateSnapshot("analytics");
    const second = store.getStateSnapshot("analytics");

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual({
      data: undefined,
      status: "missing",
      error: null,
      stale: false,
    });
  });

  it("transitions missing to pending to loading to ready", () => {
    const store = new ResourceStore();
    const callback = vi.fn();
    store.subscribe("analytics", callback);

    const missing = store.getStateSnapshot("analytics");
    store.markPending(["analytics"]);
    const pending = store.getStateSnapshot("analytics");
    store.markLoading(["analytics"]);
    const loading = store.getStateSnapshot("analytics");
    store.set({ key: "analytics", version: "v1", value: { revenue: 95_000 } });
    const ready = store.getStateSnapshot<{ revenue: number }>("analytics");

    expect(pending).not.toBe(missing);
    expect(pending).toMatchObject({ status: "pending", error: null, stale: false });
    expect(loading).not.toBe(pending);
    expect(loading).toMatchObject({ status: "loading", error: null, stale: false });
    expect(ready).not.toBe(loading);
    expect(ready).toEqual({
      data: { revenue: 95_000 },
      status: "ready",
      error: null,
      stale: false,
    });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("transitions loading to error to loading to ready and clears errors", () => {
    const store = new ResourceStore();
    store.markLoading(["activity"]);
    store.setResourceError("activity", {
      type: "ResourceError",
      message: "A deferred resource could not be resolved",
    });

    const failed = store.getStateSnapshot("activity");
    expect(failed.status).toBe("error");
    expect(failed.error).toEqual({
      type: "ResourceError",
      message: "A deferred resource could not be resolved",
    });
    expect(Object.isFrozen(failed.error)).toBe(true);

    store.markLoading(["activity"]);
    expect(store.getStateSnapshot("activity")).toMatchObject({
      status: "loading",
      error: null,
    });

    store.set({ key: "activity", version: "v1", value: [] });
    expect(store.getStateSnapshot("activity")).toEqual({
      data: [],
      status: "ready",
      error: null,
      stale: false,
    });
  });

  it("preserves stale data while loading or reporting a refresh error", () => {
    const store = new ResourceStore();
    const data = { count: 1 };
    store.set({ key: "summary", version: "v1", value: data });

    store.markLoading(["summary"]);
    expect(store.getStateSnapshot("summary")).toEqual({
      data,
      status: "loading",
      error: null,
      stale: true,
    });
    expect(store.exportKnownVersions()).toEqual({});

    store.setResourceError("summary", {
      type: "ResourceError",
      message: "Refresh failed",
    });
    expect(store.getStateSnapshot("summary")).toEqual({
      data,
      status: "error",
      error: { type: "ResourceError", message: "Refresh failed" },
      stale: true,
    });

    store.clearResourceError("summary");
    expect(store.getStateSnapshot("summary")).toEqual({
      data,
      status: "ready",
      error: null,
      stale: true,
    });
  });

  it("lets a successful set clear an error even when the version is unchanged", () => {
    const store = new ResourceStore();
    const data = { count: 1 };
    store.set({ key: "summary", version: "v1", value: data });
    store.setResourceError("summary", {
      type: "ResourceError",
      message: "Refresh failed",
    });

    expect(store.set({ key: "summary", version: "v1", value: data })).toBe(true);
    expect(store.getStateSnapshot("summary")).toEqual({
      data,
      status: "ready",
      error: null,
      stale: false,
    });
  });

  it("invalidates state-only and ready resources back to missing", () => {
    const store = new ResourceStore();
    const callback = vi.fn();
    store.subscribe("analytics", callback);

    store.markPending(["analytics"]);
    store.invalidate("analytics");
    expect(store.getStateSnapshot("analytics").status).toBe("missing");

    store.set({ key: "analytics", version: "v1", value: { value: 1 } });
    store.invalidate("analytics");
    expect(store.getStateSnapshot("analytics").status).toBe("missing");
    expect(store.getSnapshot("analytics")).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it("keeps patched resources ready but marks their canonical version stale", () => {
    const store = new ResourceStore();
    store.set({ key: "rooms", version: "v1", value: [{ id: 1, open: true }] });

    store.patch("rooms", [
      { op: "replace-item", id: 1, value: { id: 1, open: false } },
    ]);

    expect(store.getStateSnapshot("rooms")).toMatchObject({
      data: [{ id: 1, open: false }],
      status: "ready",
      error: null,
      stale: true,
    });
    expect(store.exportKnownVersions()).toEqual({});
  });

  it("does not notify or replace snapshots for repeated identical states", () => {
    const store = new ResourceStore();
    const callback = vi.fn();
    store.subscribe("analytics", callback);

    store.markPending(["analytics"]);
    const pending = store.getStateSnapshot("analytics");
    store.markPending(["analytics"]);

    expect(store.getStateSnapshot("analytics")).toBe(pending);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("stores and retrieves resource values with stable snapshots", () => {
    const store = new ResourceStore();
    const data = { name: "Grand Hotel", stars: 5 };

    store.set({ key: "hotel", version: "v1", value: data });

    const snap1 = store.getSnapshot("hotel");
    const snap2 = store.getSnapshot("hotel");

    expect(snap1).toEqual(data);
    expect(snap1).toBe(snap2); // Exact reference equality for useSyncExternalStore
  });

  it("notifies only the subscribers of the specific changed key", () => {
    const store = new ResourceStore();
    const hotelCallback = vi.fn();
    const authCallback = vi.fn();

    store.subscribe("hotel", hotelCallback);
    store.subscribe("auth", authCallback);

    // Update only 'hotel'
    store.set({ key: "hotel", version: "v1", value: { name: "Hotel A" } });

    expect(hotelCallback).toHaveBeenCalledTimes(1);
    expect(authCallback).toHaveBeenCalledTimes(0); // MUST NOT be called!

    // Update 'auth'
    store.set({ key: "auth", version: "a1", value: { user: "alice" } });

    expect(hotelCallback).toHaveBeenCalledTimes(1);
    expect(authCallback).toHaveBeenCalledTimes(1);
  });

  it("does not re-notify if set with identical version and value", () => {
    const store = new ResourceStore();
    const cb = vi.fn();
    const data = { id: 101 };

    store.subscribe("room", cb);
    store.set({ key: "room", version: "v1", value: data });
    expect(cb).toHaveBeenCalledTimes(1);

    // Re-set with identical version and reference
    const changed = store.set({ key: "room", version: "v1", value: data });
    expect(changed).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("treats an opaque version as authoritative even with a new value reference", () => {
    const store = new ResourceStore();
    const callback = vi.fn();
    store.subscribe("hotel", callback);
    store.set({ key: "hotel", version: "v1", value: { name: "A" } });
    store.set({ key: "hotel", version: "v1", value: { name: "B" } });

    expect(store.getSnapshot("hotel")).toEqual({ name: "A" });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("exports known versions according to LRU usage", () => {
    const store = new ResourceStore();
    store.set({ key: "k1", version: "v1", value: 1 });
    store.set({ key: "k2", version: "v2", value: 2 });
    store.set({ key: "k3", version: "v3", value: 3 });

    // Touch k1
    store.getSnapshot("k1");

    const known = store.exportKnownVersions(2);
    expect(known).toEqual({
      k1: "v1",
      k3: "v3",
    });
  });

  it("invalidates and clears resources", () => {
    const store = new ResourceStore();
    const cb = vi.fn();

    store.subscribe("auth", cb);
    store.set({ key: "auth", version: "v1", value: { id: 1 } });
    expect(store.getSnapshot("auth")).toBeDefined();

    store.invalidate("auth");
    expect(store.getSnapshot("auth")).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("bounds resources with LRU eviction and never exports stale versions", () => {
    const store = new ResourceStore({ maxResources: 2 });
    store.set({ key: "one", version: "v1", value: 1 });
    store.set({ key: "two", version: "v2", value: 2 });
    store.getSnapshot("one");
    store.set({ key: "three", version: "v3", value: 3 });

    expect(store.getSnapshot("two")).toBeUndefined();
    store.markStale("one");
    expect(store.getSnapshot("one")).toBe(1);
    expect(store.exportKnownVersions()).toEqual({ three: "v3" });
  });
});

describe("PageStore", () => {
  it("updates page state and notifies subscribers", () => {
    const pageStore = new PageStore({ component: "home", url: "/" });
    const cb = vi.fn();

    pageStore.subscribe(cb);
    expect(pageStore.getSnapshot().component).toBe("home");

    pageStore.setPage({ component: "dashboard", url: "/dashboard", meta: { title: "Dash" } });
    expect(pageStore.getSnapshot().component).toBe("dashboard");
    expect(pageStore.getSnapshot().meta.title).toBe("Dash");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
