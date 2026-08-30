/** Core navigation engine and coordinator. It has no UI-framework imports. */

import { PageCache } from "./cache";
import {
  EventEmitter,
  FluxEventListener,
  FluxEventName,
  type ResourceLoadReason,
} from "./events";
import { HistoryManager } from "./history";
import { LiveManager } from "./live/manager";
import type { LiveEvent } from "./live/protocol";
import type { LiveTransport } from "./live/transport";
import { MutationEnvelope, PageDescriptor, PageEnvelope } from "./protocol";
import { PrefetchManager } from "./prefetch";
import { PageStore, ResourceStore } from "./store";
import { createFetchTransport, FluxTransport } from "./transport";

export interface VisitOptions {
  replace?: boolean;
  preserveScroll?: boolean;
  preserveState?: boolean;
  usePrefetch?: boolean;
  headers?: Record<string, string>;
  only?: string[];
}

export interface RefreshOptions {
  only?: string[];
}

export interface LoadResourcesOptions {
  url?: string;
  reason: ResourceLoadReason;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface MutateOptions {
  method?: string;
  headers?: Record<string, string>;
  preserveScroll?: boolean;
}

export interface FluxRuntimeOptions {
  resourceStore?: ResourceStore;
  pageStore?: PageStore;
  transport?: FluxTransport;
  history?: HistoryManager;
  prefetchManager?: PrefetchManager;
  pageCache?: PageCache;
  liveManager?: LiveManager;
  liveTransport?: LiveTransport;
  liveBatchDelayMs?: number;
  initialEnvelope?: PageEnvelope;
  initialPage?: PageDescriptor;
  initialResources?: PageEnvelope["resources"];
  maxResources?: number;
  maxPages?: number;
  hardNavigate?: (url: string) => void;
  deferHistory?: boolean;
}

export class FluxRouter {
  public readonly resourceStore: ResourceStore;
  public readonly pageStore: PageStore;
  public readonly transport: FluxTransport;
  public readonly events: EventEmitter;
  public readonly history: HistoryManager;
  public readonly prefetchManager: PrefetchManager;
  public readonly pageCache: PageCache;
  public readonly liveManager: LiveManager;
  public readonly clientId: string;

  private currentVisitId: string | null = null;
  private activeController: AbortController | null = null;
  private activeDeferredController: AbortController | null = null;
  private activeDeferredKeys: string[] = [];
  private activeDeferredEpochs = new Map<string, number>();
  private visitCounter = 0;
  private resourceLoadCounter = 0;
  private resourceEpochCounter = 0;
  private readonly resourceEpochs = new Map<string, number>();
  private initialDeferredBatch?: { keys: string[]; url: string };
  private initialDeferredPromise?: Promise<void>;
  private readonly hardNavigate: (url: string) => void;
  private stopHistoryListener?: () => void;
  private stopLiveEventListener?: () => void;
  private liveStarted = false;
  private readonly liveBatchDelayMs: number;
  private readonly pendingLiveRefreshKeys = new Set<string>();
  private liveRefreshTimer?: ReturnType<typeof setTimeout>;

  constructor(options: FluxRuntimeOptions = {}) {
    const initialPage = options.initialEnvelope?.page ?? options.initialPage;
    this.resourceStore =
      options.resourceStore ??
      new ResourceStore({ maxResources: options.maxResources });
    this.pageStore = options.pageStore ?? new PageStore(initialPage);
    this.transport = options.transport ?? createFetchTransport();
    this.events = new EventEmitter();
    this.history = options.history ?? new HistoryManager();
    this.prefetchManager = options.prefetchManager ?? new PrefetchManager();
    this.pageCache = options.pageCache ?? new PageCache(options.maxPages);
    const liveBatchDelayMs = options.liveBatchDelayMs ?? 15;
    if (!Number.isFinite(liveBatchDelayMs) || liveBatchDelayMs < 0) {
      throw new RangeError("liveBatchDelayMs must be a finite non-negative number");
    }
    this.liveBatchDelayMs = liveBatchDelayMs;
    this.liveManager =
      options.liveManager ?? new LiveManager({ transport: options.liveTransport });
    this.clientId = this.liveManager.clientId;
    this.stopLiveEventListener = this.liveManager.subscribeEvents(event => {
      this.handleLiveEvent(event);
    });
    this.hardNavigate =
      options.hardNavigate ??
      (url => {
        if (typeof window !== "undefined") window.location.assign(url);
      });

    const initialResources =
      options.initialEnvelope?.resources ?? options.initialResources;
    if (initialResources) {
      this.emitResourceUpdates(this.resourceStore.setMany(initialResources));
    }
    for (const [key, error] of Object.entries(
      options.initialEnvelope?.resourceErrors ?? {}
    )) {
      this.resourceStore.setResourceError(key, error);
    }
    if (options.initialEnvelope?.deferred?.length) {
      const keys = [...options.initialEnvelope.deferred];
      this.resourceStore.markPending(keys);
      this.initialDeferredBatch = {
        keys,
        url: options.initialEnvelope.page.url || "/",
      };
    }
    if (initialPage) {
      if (options.initialEnvelope) {
        this.cachePageEnvelope(options.initialEnvelope);
      } else {
        this.pageCache.set(
          initialPage,
          this.resourceStore.exportKnownVersions()
        );
      }
    }
    if (options.initialEnvelope) {
      this.liveManager.updateManifest(
        options.initialEnvelope.page.url || "/",
        options.initialEnvelope.live ?? []
      );
    }

    if (!options.deferHistory) this.startHistory();
  }

  startHistory(): void {
    if (this.stopHistoryListener) return;
    this.stopHistoryListener = this.history.onPopState(url => {
      const cached = this.pageCache.getValid(url, this.resourceStore);
      if (cached) {
        if (this.liveStarted) this.liveManager.disconnect();
        this.cancelPendingLiveRefresh();
        this.abortActiveDeferred();
        this.abortActiveVisit();
        this.resourceStore.markPending(cached.pendingDeferred);
        this.pageStore.setPage(cached);
        this.events.emit("cache:hit", { key: url });
        if (cached.pendingDeferred.length > 0) {
          void this.startDeferredBatch(
            cached.pendingDeferred,
            cached.url || url
          ).catch(() => undefined);
        }
        return;
      }
      this.events.emit("cache:miss", { key: url });
      void this.visit(url, {
        preserveState: true,
        replace: true,
        usePrefetch: false,
      }).catch(error => {
        console.error("[fluxfast] Popstate navigation error:", error);
      });
    });
  }

  stopHistory(): void {
    this.stopHistoryListener?.();
    this.stopHistoryListener = undefined;
  }

  on<E extends FluxEventName>(
    event: E,
    listener: FluxEventListener<E>
  ): () => void {
    return this.events.on(event, listener);
  }

  async visit(url: string, options: VisitOptions = {}): Promise<void> {
    const visitId = `visit_${++this.visitCounter}_${Date.now().toString(36)}`;
    this.abortActiveDeferred();
    this.abortActiveVisit();
    if (this.liveStarted) {
      this.supersedeLiveWork();
      this.liveManager.disconnect();
    }
    this.cancelPendingLiveRefresh();
    this.currentVisitId = visitId;

    const controller = new AbortController();
    this.activeController = controller;
    this.events.emit("visit:start", { visitId, url });

    try {
      const knownVersions = this.resourceStore.exportKnownVersions();
      let envelope: PageEnvelope | undefined;

      if (options.usePrefetch !== false && !options.only?.length) {
        envelope = this.prefetchManager.getCached(url, knownVersions);
        if (envelope) this.events.emit("cache:hit", { key: url });
      }

      if (!envelope && options.usePrefetch !== false && !options.only?.length) {
        envelope = await this.prefetchManager.getPending(url, knownVersions);
      }

      if (!envelope) {
        this.events.emit("cache:miss", { key: url });
        envelope = await this.transport.visit({
          url,
          visitId,
          knownVersions,
          only: options.only,
          signal: controller.signal,
          headers: options.headers,
        });
      }

      if (this.currentVisitId !== visitId) {
        this.events.emit("visit:cancel", { visitId, url });
        return;
      }

      this.applyPageEnvelope(envelope);

      if (!options.preserveState) {
        if (options.replace) this.history.replace(envelope.page.url || url);
        else this.history.push(envelope.page.url || url);
      }

      if (!options.preserveScroll && typeof window !== "undefined") {
        window.scrollTo({ top: 0, left: 0 });
      }

      this.events.emit("visit:success", {
        visitId,
        url: envelope.page.url || url,
        component: envelope.page.component,
      });
      this.startDeferredEnvelope(envelope);
    } catch (error) {
      if (this.currentVisitId === visitId && this.liveStarted) {
        this.liveManager.connect();
      }
      if (
        (error instanceof Error && error.name === "AbortError") ||
        controller.signal.aborted
      ) {
        this.events.emit("visit:cancel", { visitId, url });
        return;
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.events.emit("visit:error", { visitId, url, error: normalized });
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  async refresh(options: RefreshOptions = {}): Promise<void> {
    const currentUrl = this.pageStore.getSnapshot().url || "/";
    if (options.only?.length) {
      await this.loadResources(options.only, {
        url: currentUrl,
        reason: "refresh",
      });
      return;
    }
    await this.visit(currentUrl, {
      preserveState: true,
      preserveScroll: true,
      usePrefetch: false,
    });
  }

  /** Start initial deferred work after hydration. Repeated calls share one request. */
  startInitialDeferred(): Promise<void> {
    if (this.initialDeferredPromise) return this.initialDeferredPromise;
    if (!this.initialDeferredBatch) {
      this.initialDeferredPromise = Promise.resolve();
      return this.initialDeferredPromise;
    }

    const batch = this.initialDeferredBatch;
    this.initialDeferredBatch = undefined;
    this.initialDeferredPromise = this.startDeferredBatch(batch.keys, batch.url);
    return this.initialDeferredPromise;
  }

  /** Start the current page's live stream after browser hydration. */
  startLive(): void {
    this.liveStarted = true;
    this.liveManager.connect();
  }

  /** Stop live synchronization while retaining the current page manifest. */
  stopLive(): void {
    this.liveStarted = false;
    this.supersedeLiveWork();
    this.cancelPendingLiveRefresh();
    this.liveManager.disconnect();
  }

  /** Load a resource batch without changing the current page or browser history. */
  async loadResources(
    keys: string[],
    options: LoadResourcesOptions
  ): Promise<void> {
    const requestedKeys = Array.from(new Set(
      keys.filter((key): key is string => typeof key === "string" && key.length > 0)
    ));
    if (requestedKeys.length === 0) return;

    const url = options.url ?? (this.pageStore.getSnapshot().url || "/");
    const knownVersions = this.resourceStore.exportKnownVersions();
    const loadId = `resource_${options.reason}_${++this.resourceLoadCounter}_${Date.now().toString(36)}`;
    const capturedEpochs = new Map<string, number>();
    for (const key of requestedKeys) {
      capturedEpochs.set(key, this.bumpResourceEpoch(key));
    }
    this.resourceStore.markLoading(requestedKeys);
    const loadEvent = {
      url,
      keys: [...requestedKeys],
      reason: options.reason,
    };
    this.events.emit("resource:load:start", loadEvent);

    try {
      const envelope = await this.transport.visit({
        url,
        visitId: loadId,
        knownVersions,
        only: requestedKeys,
        signal: options.signal,
        headers: options.headers,
      });
      const returnedKeys = new Set(Object.keys(envelope.resources));
      const errorKeys = new Set(Object.keys(envelope.resourceErrors ?? {}));
      const settledKeys: string[] = [];
      for (const key of requestedKeys) {
        if (this.resourceEpochs.get(key) !== capturedEpochs.get(key)) continue;

        if (returnedKeys.has(key)) {
          const record = envelope.resources[key];
          if (this.resourceStore.set({
            key,
            version: record.version,
            value: record.value,
          })) {
            this.events.emit("resource:update", { key, version: record.version });
          }
          settledKeys.push(key);
          continue;
        }
        if (errorKeys.has(key)) {
          const resourceError = envelope.resourceErrors![key];
          this.resourceStore.setResourceError(key, resourceError);
          this.events.emit("resource:error", {
            ...loadEvent,
            key,
            error: resourceError,
          });
          settledKeys.push(key);
          continue;
        }

        const record = this.resourceStore.getRecord(key);
        if (record) {
          if (this.resourceStore.set({
            key,
            version: record.version,
            value: record.value,
          })) {
            this.events.emit("resource:update", { key, version: record.version });
          }
        } else {
          this.resourceStore.invalidate(key);
        }
        settledKeys.push(key);
      }
      this.pageCache.settleResources(url, settledKeys, this.resourceStore);
      this.events.emit("resource:load:success", loadEvent);
    } catch (error) {
      const aborted =
        options.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError");
      const normalized = error instanceof Error
        ? error
        : new Error(String(error));
      const settledKeys: string[] = [];
      for (const key of requestedKeys) {
        if (this.resourceEpochs.get(key) !== capturedEpochs.get(key)) continue;
        const record = this.resourceStore.getRecord(key);
        if (aborted) {
          if (record) {
            this.resourceStore.set({
              key,
              version: record.version,
              value: record.value,
            });
          } else {
            this.resourceStore.invalidate(key);
          }
        } else {
          const resourceError = {
            type: normalized.name || "ResourceError",
            message: normalized.message,
          };
          this.resourceStore.setResourceError(key, resourceError);
          this.events.emit("resource:error", {
            ...loadEvent,
            key,
            error: resourceError,
          });
          settledKeys.push(key);
        }
      }
      if (!aborted) {
        this.pageCache.settleResources(url, settledKeys, this.resourceStore);
      }
      this.events.emit("resource:load:error", {
        ...loadEvent,
        error: normalized,
      });
      throw error;
    }
  }

  async prefetch(url: string): Promise<PageEnvelope> {
    this.events.emit("prefetch:start", { url });
    const knownVersions = this.resourceStore.exportKnownVersions();
    const envelope = await this.prefetchManager.fetch(
      url,
      this.transport,
      knownVersions
    );
    for (const key of Object.keys(envelope.resources)) {
      this.bumpResourceEpoch(key);
    }
    this.emitResourceUpdates(this.resourceStore.setMany(envelope.resources));
    this.cachePageEnvelope(envelope);
    this.events.emit("prefetch:success", { url });
    return envelope;
  }

  async mutate(
    url: string,
    data?: unknown,
    options: MutateOptions = {}
  ): Promise<MutationEnvelope> {
    this.events.emit("mutation:start", { url });

    try {
      const envelope = await this.transport.mutate({
        url,
        data,
        method: options.method ?? "POST",
        headers: options.headers,
        clientId: this.clientId,
      });

      for (const [key, patches] of Object.entries(
        envelope.mutation.patches ?? {}
      )) {
        this.bumpResourceEpoch(key);
        if (this.resourceStore.patch(key, patches)) {
          const version = this.resourceStore.getRecord(key)?.version ?? "";
          this.events.emit("resource:update", { key, version });
        } else {
          this.resourceStore.invalidate(key);
        }
      }

      const activeInvalidations: string[] = [];
      for (const key of envelope.mutation.invalidate ?? []) {
        this.bumpResourceEpoch(key);
        if (this.resourceStore.hasSubscribers(key)) {
          this.resourceStore.markStale(key);
          activeInvalidations.push(key);
        } else {
          this.resourceStore.invalidate(key);
        }
        this.events.emit("resource:invalidate", { key });
      }

      if (envelope.mutation.externalRedirect) {
        this.hardNavigate(envelope.mutation.externalRedirect);
      } else if (envelope.mutation.redirect) {
        await this.visit(envelope.mutation.redirect, {
          preserveScroll: options.preserveScroll,
        });
      } else if (activeInvalidations.length > 0) {
        await this.loadResources(activeInvalidations, {
          url: this.pageStore.getSnapshot().url || "/",
          reason: "mutation",
        });
      }

      this.events.emit("mutation:success", { url });
      return envelope;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.events.emit("mutation:error", { url, error: normalized });
      throw error;
    }
  }

  clear(): void {
    this.abortActiveDeferred();
    this.abortActiveVisit();
    this.liveStarted = false;
    this.supersedeLiveWork();
    this.cancelPendingLiveRefresh();
    this.liveManager.clear();
    this.resourceStore.clear();
    this.pageStore.clear();
    this.pageCache.clear();
    this.prefetchManager.clear();
    this.resourceEpochs.clear();
  }

  destroy(): void {
    this.abortActiveDeferred();
    this.abortActiveVisit();
    this.liveStarted = false;
    this.supersedeLiveWork();
    this.cancelPendingLiveRefresh();
    this.stopLiveEventListener?.();
    this.stopLiveEventListener = undefined;
    this.liveManager.destroy();
    this.stopHistory();
    this.history.destroy();
    this.events.removeAllListeners();
  }

  private applyPageEnvelope(envelope: PageEnvelope): void {
    const envelopeKeys = new Set([
      ...Object.keys(envelope.resources),
      ...Object.keys(envelope.resourceErrors ?? {}),
      ...(envelope.deferred ?? []),
      ...(envelope.resourceKeys ?? []),
    ]);
    for (const key of envelopeKeys) this.bumpResourceEpoch(key);
    this.emitResourceUpdates(this.resourceStore.setMany(envelope.resources));
    for (const [key, error] of Object.entries(envelope.resourceErrors ?? {})) {
      this.resourceStore.setResourceError(key, error);
    }
    this.resourceStore.markPending(envelope.deferred ?? []);
    this.pageStore.setPage(envelope.page);
    this.liveManager.updateManifest(
      envelope.page.url || "/",
      envelope.live ?? []
    );
    if (this.liveStarted) this.liveManager.connect();
    this.cachePageEnvelope(envelope);
  }

  private cachePageEnvelope(envelope: PageEnvelope): void {
    const allKnownVersions = this.resourceStore.exportKnownVersions();
    if (!envelope.resourceKeys) {
      this.pageCache.set(envelope.page, allKnownVersions);
      return;
    }

    const resourceKeys = Array.from(new Set(envelope.resourceKeys));
    const pendingDeferred = Array.from(new Set(envelope.deferred ?? []))
      .filter(key => resourceKeys.includes(key));
    const versions: Record<string, string> = {};
    for (const key of resourceKeys) {
      const version = allKnownVersions[key];
      if (version !== undefined) versions[key] = version;
    }
    this.pageCache.set(envelope.page, versions, {
      resourceKeys,
      pendingDeferred,
    });
  }

  private emitResourceUpdates(keys: string[]): void {
    for (const key of keys) {
      const version = this.resourceStore.getRecord(key)?.version ?? "";
      this.events.emit("resource:update", { key, version });
    }
  }

  private handleLiveEvent(event: LiveEvent): void {
    if (
      (event.type === "invalidate" || event.type === "patch") &&
      event.originClientId === this.clientId
    ) {
      return;
    }

    const activeKeys = new Set(this.liveManager.getManifest()?.keys ?? []);
    if (event.type === "patch") {
      const keys = Object.keys(event.patches).filter(key => activeKeys.has(key));
      for (const key of keys) {
        this.bumpResourceEpoch(key);
        if (this.resourceStore.patch(key, event.patches[key])) {
          const version = this.resourceStore.getRecord(key)?.version ?? "";
          this.events.emit("resource:update", { key, version });
        }
      }
      this.queueLiveRefresh(keys);
      return;
    }
    if (event.type !== "invalidate" && event.type !== "resync") return;
    const keys = event.keys.filter(key => activeKeys.has(key));
    if (keys.length === 0) return;

    for (const key of keys) {
      this.bumpResourceEpoch(key);
      this.resourceStore.markStale(key);
      this.events.emit("resource:invalidate", { key });
    }
    this.queueLiveRefresh(keys);
  }

  private queueLiveRefresh(keys: string[]): void {
    for (const key of keys) this.pendingLiveRefreshKeys.add(key);
    if (keys.length === 0) return;
    if (this.liveRefreshTimer !== undefined) return;
    this.liveRefreshTimer = setTimeout(() => {
      this.liveRefreshTimer = undefined;
      const manifest = this.liveManager.getManifest();
      const stillActive = new Set(manifest?.keys ?? []);
      const pending = [...this.pendingLiveRefreshKeys]
        .filter(key => stillActive.has(key))
        .sort();
      this.pendingLiveRefreshKeys.clear();
      if (!manifest || pending.length === 0 || !this.liveStarted) return;
      void this.loadResources(pending, {
        url: manifest.url,
        reason: "live",
      }).catch(() => undefined);
    }, this.liveBatchDelayMs);
  }

  private cancelPendingLiveRefresh(): void {
    if (this.liveRefreshTimer !== undefined) {
      clearTimeout(this.liveRefreshTimer);
      this.liveRefreshTimer = undefined;
    }
    this.pendingLiveRefreshKeys.clear();
  }

  private supersedeLiveWork(): void {
    for (const key of this.liveManager.getManifest()?.keys ?? []) {
      this.bumpResourceEpoch(key);
    }
  }

  private abortActiveVisit(): void {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
    this.currentVisitId = null;
  }

  private bumpResourceEpoch(key: string): number {
    const epoch = ++this.resourceEpochCounter;
    this.resourceEpochs.set(key, epoch);
    return epoch;
  }

  private startDeferredEnvelope(envelope: PageEnvelope): void {
    if (!envelope.deferred?.length) return;
    void this.startDeferredBatch(
      envelope.deferred,
      envelope.page.url || "/"
    ).catch(() => undefined);
  }

  private startDeferredBatch(keys: string[], url: string): Promise<void> {
    this.abortActiveDeferred();
    const controller = new AbortController();
    this.activeDeferredController = controller;
    this.activeDeferredKeys = [...keys];
    const promise = this.loadResources(keys, {
      url,
      reason: "deferred",
      signal: controller.signal,
    });
    this.activeDeferredEpochs = new Map(
      keys.map(key => [key, this.resourceEpochs.get(key) ?? 0])
    );
    void promise.finally(() => {
      if (this.activeDeferredController === controller) {
        this.activeDeferredController = null;
        this.activeDeferredKeys = [];
        this.activeDeferredEpochs.clear();
      }
    }).catch(() => undefined);
    return promise;
  }

  private abortActiveDeferred(): void {
    if (!this.activeDeferredController) return;
    for (const key of this.activeDeferredKeys) {
      if (this.resourceEpochs.get(key) !== this.activeDeferredEpochs.get(key)) {
        continue;
      }
      this.bumpResourceEpoch(key);
      const record = this.resourceStore.getRecord(key);
      if (record) {
        this.resourceStore.set({
          key,
          version: record.version,
          value: record.value,
        });
        this.resourceStore.markStale(key);
      } else {
        this.resourceStore.invalidate(key);
      }
    }
    this.activeDeferredController.abort();
    this.activeDeferredController = null;
    this.activeDeferredKeys = [];
    this.activeDeferredEpochs.clear();
  }
}

export function createFluxRuntime(options: FluxRuntimeOptions = {}): FluxRouter {
  return new FluxRouter(options);
}
