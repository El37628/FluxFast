/** In-flight request deduplication and version-safe prefetch caching. */

import { PageEnvelope } from "./protocol";
import { FluxTransport } from "./transport";

export interface PrefetchEntry {
  readonly envelope: PageEnvelope;
  readonly expiresAt: number;
  readonly basedOnVersions: Record<string, string>;
}

function fingerprint(url: string, knownVersions: Record<string, string>): string {
  const versions = Object.entries(knownVersions).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([url, versions]);
}

function versionsStillAvailable(
  basedOn: Record<string, string>,
  current: Record<string, string>,
  envelope: PageEnvelope
): boolean {
  return Object.entries(basedOn).every(([key, version]) => {
    const expected = envelope.resources[key]?.version ?? version;
    return current[key] === expected;
  });
}

export class PrefetchManager {
  private readonly inFlight = new Map<string, Promise<PageEnvelope>>();
  private readonly cache = new Map<string, PrefetchEntry>();
  private generation = 0;

  constructor(private readonly defaultTtlMs: number = 10_000) {}

  async fetch(
    url: string,
    transport: FluxTransport,
    knownVersions: Record<string, string>,
    ttlMs: number = this.defaultTtlMs
  ): Promise<PageEnvelope> {
    const cached = this.getCached(url, knownVersions);
    if (cached) return cached;

    const requestFingerprint = fingerprint(url, knownVersions);
    const pending = this.inFlight.get(requestFingerprint);
    if (pending) return pending;

    const generation = this.generation;
    const promise = transport
      .visit({
        url,
        visitId: `prefetch_${Date.now().toString(36)}`,
        knownVersions,
      })
      .then(envelope => {
        if (generation !== this.generation) {
          const cancellation = new Error("Prefetch was cleared");
          cancellation.name = "AbortError";
          throw cancellation;
        }
        this.cache.set(url, {
          envelope,
          expiresAt: Date.now() + ttlMs,
          basedOnVersions: { ...knownVersions },
        });
        return envelope;
      })
      .finally(() => {
        this.inFlight.delete(requestFingerprint);
      });

    this.inFlight.set(requestFingerprint, promise);
    return promise;
  }

  getPending(
    url: string,
    knownVersions: Record<string, string>
  ): Promise<PageEnvelope> | undefined {
    return this.inFlight.get(fingerprint(url, knownVersions));
  }

  getCached(
    url: string,
    currentVersions: Record<string, string>
  ): PageEnvelope | undefined {
    const entry = this.cache.get(url);
    if (!entry) return undefined;
    if (
      Date.now() >= entry.expiresAt ||
      !versionsStillAvailable(entry.basedOnVersions, currentVersions, entry.envelope)
    ) {
      this.cache.delete(url);
      return undefined;
    }
    return entry.envelope;
  }

  clear(): void {
    this.generation += 1;
    this.inFlight.clear();
    this.cache.clear();
  }
}
