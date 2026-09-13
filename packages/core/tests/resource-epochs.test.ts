import { describe, expect, it } from "vitest";
import { MAX_RESOURCE_EPOCH_ENTRIES, ResourceEpochMap } from "../src/resource-epochs";

describe("bounded resource race history", () => {
  it("retains an authoritative watermark instead of treating evicted identities as untouched", () => {
    const epochs = new ResourceEpochMap();
    for (let epoch = 1; epoch <= MAX_RESOURCE_EPOCH_ENTRIES + 100; epoch += 1) {
      epochs.set(`key-${epoch}`, { epoch, authoritativeEpoch: epoch });
    }
    expect(epochs.size).toBe(MAX_RESOURCE_EPOCH_ENTRIES);
    expect(epochs.has("key-1")).toBe(false);
    expect(epochs.get("key-1")).toEqual({ epoch: 100, authoritativeEpoch: 100, conservative: true });
    expect(epochs.get("never-seen")).toEqual(epochs.get("key-1"));
    expect(epochs.get("key-1100")).toEqual({ epoch: 1100, authoritativeEpoch: 1100 });
  });

  it("speculative eviction cannot manufacture authoritative navigation history", () => {
    const epochs = new ResourceEpochMap();
    epochs.set("authoritative", { epoch: 1, authoritativeEpoch: 1 });
    for (let epoch = 2; epoch <= MAX_RESOURCE_EPOCH_ENTRIES + 100; epoch += 1) {
      epochs.set(`prefetch-${epoch}`, { epoch, authoritativeEpoch: 0 });
    }
    expect(epochs.get("evicted")).toEqual({ epoch: 100, authoritativeEpoch: 1, conservative: true });
    // Work begun after authority 1 remains navigation-eligible, even though
    // prefetch-only work up to epoch 100 has been forgotten.
    expect(epochs.get("evicted")!.authoritativeEpoch).toBeLessThanOrEqual(1);
    epochs.clear();
    expect(epochs.size).toBe(0);
    expect(epochs.get("authoritative")).toBeUndefined();
  });
});
