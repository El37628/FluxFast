import { PageDescriptor } from "./protocol";
import { ResourceStore } from "./store";

export interface CachedPage {
  readonly url: string;
  readonly component: string;
  readonly meta: Record<string, unknown>;
  readonly resources: Record<string, string>;
}

/** Lightweight LRU page cache. Resource values remain in ResourceStore. */
export class PageCache {
  private readonly entries = new Map<string, CachedPage>();

  constructor(private readonly maxPages: number = 32) {
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new RangeError("maxPages must be a positive integer");
    }
  }

  set(page: PageDescriptor, resources: Record<string, string>): void {
    const entry: CachedPage = {
      url: page.url,
      component: page.component,
      meta: { ...(page.meta ?? {}) },
      resources: { ...resources },
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

    for (const [key, version] of Object.entries(entry.resources)) {
      const record = resources.getRecord(key);
      if (!record || record.version !== version || resources.isStale(key)) {
        this.entries.delete(url);
        return undefined;
      }
    }

    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }
}
