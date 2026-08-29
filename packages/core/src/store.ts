/**
 * Reactive ResourceStore with key-level subscriptions and stable snapshots.
 * Framework-neutral, suitable for React useSyncExternalStore or other UI bindings.
 */

import {
  PageDescriptor,
  ResourceErrorDetail,
  ResourcePatch,
  ResourceWireRecord,
} from "./protocol";
import { applyPatchToValue } from "./mutation";

export interface ResourceRecord<T = unknown> {
  readonly key: string;
  readonly version: string;
  readonly value: T;
  readonly updatedAt: number;
}

export type ResourceStatus = "missing" | "pending" | "loading" | "ready" | "error";

export interface ResourceStateSnapshot<T = unknown> {
  readonly data: T | undefined;
  readonly status: ResourceStatus;
  readonly error: Readonly<ResourceErrorDetail> | null;
  readonly stale: boolean;
}

const MISSING_RESOURCE_STATE: ResourceStateSnapshot = Object.freeze({
  data: undefined,
  status: "missing",
  error: null,
  stale: false,
});

export interface PageState {
  component: string;
  url: string;
  meta: Record<string, unknown>;
}

export class ResourceStore {
  private records: Map<string, ResourceRecord> = new Map();
  private subscribers: Map<string, Set<() => void>> = new Map();
  private globalSubscribers: Set<() => void> = new Set();
  private lruOrder: string[] = [];
  private staleKeys: Set<string> = new Set();
  private stateSnapshots: Map<string, ResourceStateSnapshot> = new Map();
  private readonly maxResources: number;

  constructor(options: { maxResources?: number } = {}) {
    const maxResources = options.maxResources ?? 128;
    if (!Number.isInteger(maxResources) || maxResources <= 0) {
      throw new RangeError("maxResources must be a positive integer");
    }
    this.maxResources = maxResources;
  }

  /**
   * Subscribe to changes for a specific resource key.
   */
  subscribe(key: string, callback: () => void): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(callback);

    return () => {
      const set = this.subscribers.get(key);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  /**
   * Subscribe to all store changes.
   */
  subscribeAll(callback: () => void): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  /**
   * Return stable snapshot of a resource value for useSyncExternalStore.
   */
  getSnapshot<T = unknown>(key: string): T | undefined {
    const rec = this.records.get(key);
    if (rec) this.touchLru(key);
    return rec ? (rec.value as T) : undefined;
  }

  /**
   * Return snapshot for server-side rendering.
   */
  getServerSnapshot<T = unknown>(key: string): T | undefined {
    const rec = this.records.get(key);
    return rec ? (rec.value as T) : undefined;
  }

  /** Return stable loading metadata for a resource key. */
  getStateSnapshot<T = unknown>(key: string): ResourceStateSnapshot<T> {
    if (this.records.has(key)) this.touchLru(key);
    return (
      this.stateSnapshots.get(key) ?? MISSING_RESOURCE_STATE
    ) as ResourceStateSnapshot<T>;
  }

  /**
   * Return full record metadata.
   */
  getRecord<T = unknown>(key: string): ResourceRecord<T> | undefined {
    const record = this.records.get(key) as ResourceRecord<T> | undefined;
    if (record) this.touchLru(key);
    return record;
  }

  /**
   * Insert or update a resource record. Only updates and notifies if version or value changed.
   */
  set<T = unknown>(record: { key: string; version: string; value: T }): boolean {
    const existing = this.records.get(record.key);
    const currentState = this.getStateSnapshot(record.key);

    if (
      existing &&
      existing.version === record.version &&
      !this.staleKeys.has(record.key) &&
      currentState.status === "ready" &&
      currentState.error === null
    ) {
      this.touchLru(record.key);
      return false;
    }

    const newRecord: ResourceRecord<T> = Object.freeze({
      key: record.key,
      version: record.version,
      value: record.value,
      updatedAt: Date.now(),
    });

    this.records.set(record.key, newRecord);
    this.staleKeys.delete(record.key);
    this.updateStateSnapshot(record.key, "ready", null, false);
    this.touchLru(record.key);
    this.evictIfNeeded();
    this.notify(record.key);
    return true;
  }

  /**
   * Set multiple wire records from a protocol response.
   */
  setMany(resources: Record<string, ResourceWireRecord>): string[] {
    const updatedKeys: string[] = [];
    for (const [key, record] of Object.entries(resources)) {
      if (this.set({
        key,
        version: record.version,
        value: record.value,
      })) {
        updatedKeys.push(key);
      }
    }
    return updatedKeys;
  }

  /** Mark resources announced for deferred resolution but not requested yet. */
  markPending(keys: string[]): void {
    for (const key of keys) {
      const hasData = this.records.has(key);
      if (hasData) this.staleKeys.add(key);
      if (this.updateStateSnapshot(key, "pending", null, hasData)) {
        this.notify(key);
      }
    }
  }

  /** Mark resources as actively loading while preserving any stale value. */
  markLoading(keys: string[]): void {
    for (const key of keys) {
      const hasData = this.records.has(key);
      if (hasData) this.staleKeys.add(key);
      if (this.updateStateSnapshot(key, "loading", null, hasData)) {
        this.notify(key);
      }
    }
  }

  /** Store a sanitized per-resource error without discarding stale data. */
  setResourceError(key: string, error: ResourceErrorDetail): void {
    const hasData = this.records.has(key);
    if (hasData) this.staleKeys.add(key);
    if (this.updateStateSnapshot(key, "error", error, hasData)) {
      this.notify(key);
    }
  }

  /** Clear a resource error and restore its ready or missing state. */
  clearResourceError(key: string): void {
    const current = this.getStateSnapshot(key);
    if (current.error === null) return;

    const hasData = this.records.has(key);
    const status: ResourceStatus = hasData ? "ready" : "missing";
    if (
      this.updateStateSnapshot(
        key,
        status,
        null,
        hasData && this.staleKeys.has(key)
      )
    ) {
      this.notify(key);
    }
  }

  /**
   * Apply mutation patches to a specific resource.
   */
  patch(key: string, patches: ResourcePatch[]): boolean {
    const existing = this.records.get(key);
    if (!existing) {
      return false;
    }

    let val = existing.value;
    for (const p of patches) {
      val = applyPatchToValue(val, p);
    }

    const newRecord: ResourceRecord = Object.freeze({
      key,
      version: `${existing.version}_p${Date.now().toString(36)}`,
      value: val,
      updatedAt: Date.now(),
    });

    this.records.set(key, newRecord);
    this.staleKeys.add(key);
    this.updateStateSnapshot(key, "ready", null, true);
    this.touchLru(key);
    this.notify(key);
    return true;
  }

  /**
   * Invalidate a resource key.
   */
  invalidate(key: string): void {
    const hadState = this.stateSnapshots.has(key);
    const hadRecord = this.records.delete(key);
    const wasStale = this.staleKeys.delete(key);
    if (!hadState && !hadRecord && !wasStale) return;

    this.stateSnapshots.delete(key);
    this.removeFromLru(key);
    this.notify(key);
  }

  /** Keep the last value visible while excluding its version from revalidation. */
  markStale(key: string): void {
    if (!this.records.has(key) || this.staleKeys.has(key)) return;

    this.staleKeys.add(key);
    const current = this.getStateSnapshot(key);
    this.updateStateSnapshot(key, current.status, current.error, true);
    this.notify(key);
  }

  isStale(key: string): boolean {
    return this.staleKeys.has(key);
  }

  hasSubscribers(key: string): boolean {
    return (this.subscribers.get(key)?.size ?? 0) > 0;
  }

  /**
   * Export map of known versions for X-FluxFast-Known header.
   */
  exportKnownVersions(limit: number = 100): Record<string, string> {
    const result: Record<string, string> = {};
    const safeLimit = Number.isFinite(limit)
      ? Math.max(0, Math.min(100, Math.floor(limit)))
      : 100;
    if (safeLimit === 0) return result;
    const keys = this.lruOrder.slice(-safeLimit).reverse();

    for (const key of keys) {
      const rec = this.records.get(key);
      if (rec && rec.version && !this.staleKeys.has(key)) {
        result[key] = rec.version;
      }
    }
    return result;
  }

  /**
   * Clear all records (e.g. upon user logout).
   */
  clear(): void {
    const allKeys = new Set([
      ...this.records.keys(),
      ...this.stateSnapshots.keys(),
      ...this.staleKeys,
    ]);
    this.records.clear();
    this.staleKeys.clear();
    this.stateSnapshots.clear();
    this.lruOrder = [];

    for (const key of allKeys) {
      this.notify(key);
    }
  }

  private updateStateSnapshot(
    key: string,
    status: ResourceStatus,
    error: Readonly<ResourceErrorDetail> | null,
    stale: boolean
  ): boolean {
    const data = this.records.get(key)?.value;
    const current = this.stateSnapshots.get(key) ?? MISSING_RESOURCE_STATE;
    const sameError =
      current.error === error ||
      (current.error !== null &&
        error !== null &&
        current.error.type === error.type &&
        current.error.message === error.message &&
        current.error.details === error.details);

    if (
      current.data === data &&
      current.status === status &&
      sameError &&
      current.stale === stale
    ) {
      return false;
    }

    if (status === "missing" && data === undefined && error === null && !stale) {
      this.stateSnapshots.delete(key);
      return true;
    }

    const frozenError = error === null
      ? null
      : sameError && current.error !== null
        ? current.error
        : Object.freeze({
            type: error.type,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          });
    this.stateSnapshots.set(key, Object.freeze({
      data,
      status,
      error: frozenError,
      stale,
    }));
    return true;
  }

  private notify(key: string): void {
    const keySubs = this.subscribers.get(key);
    if (keySubs) {
      for (const cb of Array.from(keySubs)) {
        try {
          cb();
        } catch (e) {
          console.error(`[fluxfast] Error in ResourceStore subscriber for '${key}':`, e);
        }
      }
    }

    for (const cb of Array.from(this.globalSubscribers)) {
      try {
        cb();
      } catch (e) {
        console.error("[fluxfast] Error in ResourceStore global subscriber:", e);
      }
    }
  }

  private touchLru(key: string): void {
    this.removeFromLru(key);
    this.lruOrder.push(key);
  }

  private removeFromLru(key: string): void {
    const idx = this.lruOrder.indexOf(key);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
  }

  private evictIfNeeded(): void {
    while (this.records.size > this.maxResources) {
      const oldestKey = this.lruOrder.shift();
      if (oldestKey === undefined) {
        return;
      }
      if (this.records.delete(oldestKey)) {
        this.staleKeys.delete(oldestKey);
        this.stateSnapshots.delete(oldestKey);
        this.notify(oldestKey);
      }
    }
  }
}

export class PageStore {
  private state: PageState;
  private subscribers: Set<() => void> = new Set();

  constructor(initialPage?: PageDescriptor) {
    this.state = initialPage
      ? {
          component: initialPage.component,
          url: initialPage.url,
          meta: initialPage.meta || {},
        }
      : { component: "", url: "", meta: {} };
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  getSnapshot(): PageState {
    return this.state;
  }

  setPage(page: PageDescriptor): void {
    this.state = {
      component: page.component,
      url: page.url,
      meta: page.meta || {},
    };
    for (const cb of Array.from(this.subscribers)) {
      try {
        cb();
      } catch (e) {
        console.error("[fluxfast] Error in PageStore subscriber:", e);
      }
    }
  }

  clear(): void {
    this.setPage({ component: "", url: "", meta: {} });
  }
}
