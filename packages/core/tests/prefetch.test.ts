import { describe, expect, it, vi } from "vitest";
import { PrefetchManager } from "../src/prefetch";
import type { FluxTransport } from "../src/transport";
import type { PageEnvelope } from "../src/protocol";

describe("PrefetchManager", () => {
  it("aborts and does not resurrect a response after logout-style clear", async () => {
    let resolveVisit!: (envelope: PageEnvelope) => void;
    let requestSignal: AbortSignal | undefined;
    const transport: FluxTransport = {
      visit: vi.fn(request => {
        requestSignal = request.signal;
        return new Promise(resolve => { resolveVisit = resolve; });
      }),
      mutate: vi.fn(),
    };
    const manager = new PrefetchManager();
    const pending = manager.fetch("/private", transport, { auth: "user-a" });

    manager.clear();
    expect(requestSignal?.aborted).toBe(true);
    resolveVisit({
      protocol: "fluxfast/1",
      page: { component: "private/index", url: "/private" },
      resources: { auth: { version: "user-a", value: { id: "a" } } },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.getCached("/private", { auth: "user-a" })).toBeUndefined();
  });

  it("bounds completed and in-flight prefetch state", async () => {
    const completedTransport: FluxTransport = {
      visit: vi.fn(async request => ({
        protocol: "fluxfast/1",
        page: { component: "page/index", url: request.url },
        resources: {},
      })),
      mutate: vi.fn(),
    };
    const completed = new PrefetchManager();

    for (let index = 0; index < 40; index += 1) {
      await completed.fetch(`/page-${index}`, completedTransport, {});
    }

    expect(completed.getCached("/page-0", {})).toBeUndefined();
    expect(completed.getCached("/page-39", {})).toBeDefined();

    const signals: AbortSignal[] = [];
    const pendingTransport: FluxTransport = {
      visit: vi.fn(request => {
        signals.push(request.signal!);
        return new Promise<PageEnvelope>(() => undefined);
      }),
      mutate: vi.fn(),
    };
    const pending = new PrefetchManager();

    for (let index = 0; index < 40; index += 1) {
      void pending.fetch(`/pending-${index}`, pendingTransport, {});
    }

    expect(signals.slice(0, 8).every(signal => signal.aborted)).toBe(true);
    expect(signals.slice(8).every(signal => !signal.aborted)).toBe(true);
    pending.clear();
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});
