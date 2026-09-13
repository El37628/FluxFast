import type { PageEnvelope } from "./protocol.js";

// Both official CJS and ESM builds must see the same owner-scoped policy.
// Weak owners/envelopes retain neither routers nor cached resource values.
const registryKey = Symbol.for("fluxfast.internal.prefetch-rejections.v1");
const registry = globalThis as typeof globalThis & {
  [key: symbol]: WeakMap<object, WeakSet<PageEnvelope>> | undefined;
};
const rejected = registry[registryKey] ??= new WeakMap<object, WeakSet<PageEnvelope>>();

export function rejectPrefetchEnvelope(owner: object, envelope: PageEnvelope): void {
  const envelopes = rejected.get(owner) ?? new WeakSet<PageEnvelope>();
  envelopes.add(envelope);
  rejected.set(owner, envelopes);
}

export function isRejectedPrefetchEnvelope(owner: object, envelope: PageEnvelope): boolean {
  return rejected.get(owner)?.has(envelope) ?? false;
}

export function acceptPrefetchEnvelope(owner: object, envelope: PageEnvelope): void {
  rejected.get(owner)?.delete(envelope);
}

export function clearPrefetchRejections(owner: object): void {
  rejected.delete(owner);
}
