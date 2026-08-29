import { describe, it, expect, vi } from "vitest";
import { ResourceStore, PageStore } from "../src/store";

describe("ResourceStore", () => {
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
