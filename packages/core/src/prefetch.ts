/** In-flight request deduplication and version-safe prefetch caching. */

import { PageEnvelope } from "./protocol.js";
import { FluxTransport } from "./transport.js";

const MAX_PREFETCH_ENTRIES = 32;

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
  return (
    Object.entries(basedOn).every(([key, version]) => {
      const expected = envelope.resources[key]?.version ?? version;
      return current[key] === expected;
    }) &&
    Object.entries(envelope.resources).every(([key, record]) => (
      current[key] === undefined || current[key] === record.version
    ))
  );
}

function prefetchCancellation(): Error {
  const cancellation = new Error("Prefetch was cleared or superseded");
  cancellation.name = "AbortError";
  return cancellation;
}

export class PrefetchManager {
  private readonly inFlight = new Map<string, Promise<PageEnvelope>>();
  private readonly controllers = new Map<string, AbortController>();
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
    const controller = new AbortController();
    const promise = transport
      .visit({
        url,
        visitId: `prefetch_${Date.now().toString(36)}`,
        knownVersions,
        signal: controller.signal,
      })
      .then(envelope => {
        if (generation !== this.generation || controller.signal.aborted) {
          throw prefetchCancellation();
        }
        this.pruneExpired();
        this.cache.delete(url);
        this.cache.set(url, {
          envelope,
          expiresAt: Date.now() + ttlMs,
          basedOnVersions: { ...knownVersions },
        });
        this.evictOldest(this.cache);
        return envelope;
      })
      .finally(() => {
        if (this.inFlight.get(requestFingerprint) === promise) {
          this.inFlight.delete(requestFingerprint);
        }
        if (this.controllers.get(requestFingerprint) === controller) {
          this.controllers.delete(requestFingerprint);
        }
      });

    this.inFlight.set(requestFingerprint, promise);
    this.controllers.set(requestFingerprint, controller);
    this.evictInFlight();
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
    this.cache.delete(url);
    this.cache.set(url, entry);
    return entry.envelope;
  }

  clear(): void {
    this.generation += 1;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.inFlight.clear();
    this.cache.clear();
  }

  private evictInFlight(): void {
    while (this.inFlight.size > MAX_PREFETCH_ENTRIES) {
      const oldest = this.inFlight.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.controllers.get(oldest)?.abort();
      this.controllers.delete(oldest);
      this.inFlight.delete(oldest);
    }
  }

  private evictOldest(entries: Map<string, PrefetchEntry>): void {
    while (entries.size > MAX_PREFETCH_ENTRIES) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      entries.delete(oldest);
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [url, entry] of this.cache) {
      if (now >= entry.expiresAt) this.cache.delete(url);
    }
  }
}
