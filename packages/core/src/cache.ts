import { PageDescriptor } from "./protocol.js";
import { ResourceStore } from "./store.js";

export interface CachedPage {
  readonly url: string;
  readonly component: string;
  readonly meta: Record<string, unknown>;
  readonly resources: Record<string, string>;
  readonly resourceKeys: string[];
  readonly pendingDeferred: string[];
  readonly liveKeys: string[];
}

export interface PageCacheManifest {
  readonly resourceKeys: string[];
  readonly pendingDeferred: string[];
  readonly liveKeys?: string[];
}

/** Lightweight LRU page cache. Resource values remain in ResourceStore. */
export class PageCache {
  private readonly entries = new Map<string, CachedPage>();

  constructor(private readonly maxPages: number = 32) {
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new RangeError("maxPages must be a positive integer");
    }
  }

  set(
    page: PageDescriptor,
    resources: Record<string, string>,
    manifest?: PageCacheManifest
  ): void {
    const resourceKeys = manifest?.resourceKeys ?? Object.keys(resources);
    const entry: CachedPage = {
      url: page.url,
      component: page.component,
      meta: { ...(page.meta ?? {}) },
      resources: { ...resources },
      resourceKeys: [...resourceKeys],
      pendingDeferred: [...(manifest?.pendingDeferred ?? [])],
      liveKeys: [...new Set(manifest?.liveKeys ?? [])],
    };
    this.entries.delete(page.url);
    this.entries.set(page.url, entry);

    while (this.entries.size > this.maxPages) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  getValid(url: string, resources: ResourceStore): CachedPage | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;

    const pending = new Set(entry.pendingDeferred);
    for (const key of entry.resourceKeys) {
      if (pending.has(key)) continue;

      const version = entry.resources[key];
      if (version !== undefined) {
        const record = resources.getRecord(key);
        if (record && record.version === version && !resources.isStale(key)) {
          continue;
        }
        this.entries.delete(url);
        return undefined;
      }

      if (resources.getStateSnapshot(key).status !== "error") {
        this.entries.delete(url);
        return undefined;
      }
    }

    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry;
  }

  /** Record resource-only settlement without replacing the cached page shell. */
  settleResources(url: string, keys: string[], store: ResourceStore): void {
    const entry = this.entries.get(url);
    if (!entry) return;

    const ownedKeys = new Set(entry.resourceKeys);
    const pending = new Set(entry.pendingDeferred);
    const versions = { ...entry.resources };

    for (const key of keys) {
      if (!ownedKeys.has(key)) continue;

      const state = store.getStateSnapshot(key);
      const record = store.getRecord(key);
      if (record && state.status === "ready" && !store.isStale(key)) {
        versions[key] = record.version;
        pending.delete(key);
        continue;
      }
      if (state.status === "error") {
        delete versions[key];
        pending.delete(key);
        continue;
      }
      if (state.status === "pending" || state.status === "loading") {
        continue;
      }

      this.entries.delete(url);
      return;
    }

    const updated: CachedPage = {
      ...entry,
      resources: versions,
      pendingDeferred: entry.resourceKeys.filter(key => pending.has(key)),
    };
    this.entries.delete(url);
    this.entries.set(url, updated);
  }

  clear(): void {
    this.entries.clear();
  }
}
