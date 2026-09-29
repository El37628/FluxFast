import { describe, expect, it } from "vitest";
import {
  FluxRouter,
  type FluxDiagnosticEvent,
} from "@fluxfast/core";
import {
  DevtoolsStore,
  HARD_MAX_EVENTS,
} from "../src/store";

function event(index: number): FluxDiagnosticEvent {
  return {
    id: `event-${index}`,
    timestamp: 1_700_000_000_000 + index,
    type: "navigation",
    correlationId: "visit-1",
    data: { phase: "success", url: "/rooms" },
  };
}

describe("DevtoolsStore", () => {
  it("records a bounded timeline and value-free runtime snapshots", () => {
    const router = new FluxRouter({
      deferHistory: true,
      initialPage: { component: "rooms/index", url: "/rooms?token=secret" },
    });
    router.resourceStore.set({
      key: "rooms",
      version: "rooms-v1",
      value: { token: "must-not-be-inspected" },
    });
    const store = new DevtoolsStore(router, 3);
    const stop = store.start();

    for (let index = 0; index < 5; index += 1) {
      router.diagnostics.emit(event(index));
    }

    const snapshot = store.getSnapshot();
    expect(snapshot.events.map(item => item.id)).toEqual([
      "event-2",
      "event-3",
      "event-4",
    ]);
    expect(snapshot.page).toEqual({ component: "rooms/index", url: "/rooms" });
    expect(snapshot.resources).toEqual([
      expect.objectContaining({ key: "rooms", version: "rooms-v1" }),
    ]);
    expect(JSON.stringify(snapshot.resources)).not.toContain("must-not-be-inspected");
    expect(JSON.stringify(snapshot.page)).not.toContain("secret");

    store.clearTimeline();
    expect(store.getSnapshot().events).toEqual([]);
    expect(store.getSnapshot().resources).toHaveLength(1);

    stop();
    expect(router.diagnostics.active).toBe(false);
    router.destroy();
  });

  it("consumes the initial SSR bootstrap once when recording starts", () => {
    const router = new FluxRouter({ deferHistory: true });
    router.diagnostics.bootstrap([event(1), event(2)]);
    const store = new DevtoolsStore(router);

    const stop = store.start();

    expect(store.getSnapshot().events.map(item => item.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    stop();
    store.start();
    expect(store.getSnapshot().events.map(item => item.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    store.stop();
    router.destroy();
  });

  it("rejects event bounds outside the documented hard limit", () => {
    const router = new FluxRouter({ deferHistory: true });

    expect(() => new DevtoolsStore(router, 0)).toThrow(RangeError);
    expect(() => new DevtoolsStore(router, 1.5)).toThrow(RangeError);
    expect(() => new DevtoolsStore(router, HARD_MAX_EVENTS + 1)).toThrow(
      RangeError
    );
    expect(() => new DevtoolsStore(router, HARD_MAX_EVENTS)).not.toThrow();

    router.destroy();
  });
});
