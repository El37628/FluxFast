import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_NAME,
  LIVE_RESYNC_REASONS,
  type LiveEvent,
} from "../src/live/protocol";

describe("Live Resource wire models", () => {
  it("defines the additive v1 event union without a transport", () => {
    const events: LiveEvent[] = [
      {
        protocol: "fluxfast/1",
        type: "ready",
        keys: ["summary", "activity"],
      },
      {
        protocol: "fluxfast/1",
        type: "invalidate",
        keys: ["summary"],
        originClientId: "ff_client_a",
      },
      {
        protocol: "fluxfast/1",
        type: "patch",
        patches: {
          rooms: [
            {
              op: "replace-item",
              id: 101,
              value: { id: 101, status: "occupied" },
            },
          ],
        },
        originClientId: "ff_client_a",
      },
      {
        protocol: "fluxfast/1",
        type: "resync",
        keys: ["summary", "activity"],
        reason: "overflow",
      },
    ];

    expect(LIVE_EVENT_NAME).toBe("fluxfast");
    expect(LIVE_RESYNC_REASONS).toEqual([
      "overflow",
      "reconnect",
      "broker-recovery",
      "server",
    ]);
    expect(events.map(event => event.type)).toEqual([
      "ready",
      "invalidate",
      "patch",
      "resync",
    ]);
    expect(events.every(event => event.protocol === "fluxfast/1")).toBe(true);
  });
});
