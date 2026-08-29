import { describe, expect, it, vi } from "vitest";
import { PrefetchManager } from "../src/prefetch";
import type { FluxTransport } from "../src/transport";
import type { PageEnvelope } from "../src/protocol";

describe("PrefetchManager", () => {
  it("does not resurrect a response after logout-style clear", async () => {
    let resolveVisit!: (envelope: PageEnvelope) => void;
    const transport: FluxTransport = {
      visit: vi.fn(() => new Promise(resolve => { resolveVisit = resolve; })),
      mutate: vi.fn(),
    };
    const manager = new PrefetchManager();
    const pending = manager.fetch("/private", transport, { auth: "user-a" });

    manager.clear();
    resolveVisit({
      protocol: "fluxfast/1",
      page: { component: "private/index", url: "/private" },
      resources: { auth: { version: "user-a", value: { id: "a" } } },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.getCached("/private", { auth: "user-a" })).toBeUndefined();
  });
});
