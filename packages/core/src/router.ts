/** Core navigation engine and coordinator. It has no UI-framework imports. */

import { PageCache } from "./cache";
import { EventEmitter, FluxEventListener, FluxEventName } from "./events";
import { HistoryManager } from "./history";
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

export type ResourceLoadReason = "deferred" | "refresh" | "mutation" | "retry";

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

  private currentVisitId: string | null = null;
  private activeController: AbortController | null = null;
  private visitCounter = 0;
  private resourceLoadCounter = 0;
  private readonly hardNavigate: (url: string) => void;
  private stopHistoryListener?: () => void;

  constructor(options: FluxRuntimeOptions = {}) {
    this.resourceStore =
      options.resourceStore ??
      new ResourceStore({ maxResources: options.maxResources });
    this.pageStore = options.pageStore ?? new PageStore(options.initialPage);
    this.transport = options.transport ?? createFetchTransport();
    this.events = new EventEmitter();
    this.history = options.history ?? new HistoryManager();
    this.prefetchManager = options.prefetchManager ?? new PrefetchManager();
    this.pageCache = options.pageCache ?? new PageCache(options.maxPages);
    this.hardNavigate =
      options.hardNavigate ??
      (url => {
        if (typeof window !== "undefined") window.location.assign(url);
      });

    if (options.initialResources) {
      this.emitResourceUpdates(this.resourceStore.setMany(options.initialResources));
    }
    if (options.initialPage) {
      this.pageCache.set(
        options.initialPage,
        this.resourceStore.exportKnownVersions()
      );
    }

    if (!options.deferHistory) this.startHistory();
  }

  startHistory(): void {
    if (this.stopHistoryListener) return;
    this.stopHistoryListener = this.history.onPopState(url => {
      const cached = this.pageCache.getValid(url, this.resourceStore);
      if (cached) {
        this.abortActiveVisit();
        this.pageStore.setPage(cached);
        this.events.emit("cache:hit", { key: url });
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
    this.abortActiveVisit();
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
    } catch (error) {
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
    this.resourceStore.markLoading(requestedKeys);

    try {
      const envelope = await this.transport.visit({
        url,
        visitId: loadId,
        knownVersions,
        only: requestedKeys,
        signal: options.signal,
        headers: options.headers,
      });
      const updatedKeys = this.resourceStore.setMany(envelope.resources);
      this.emitResourceUpdates(updatedKeys);

      const returnedKeys = new Set(Object.keys(envelope.resources));
      const errorKeys = new Set(Object.keys(envelope.resourceErrors ?? {}));
      for (const [key, error] of Object.entries(envelope.resourceErrors ?? {})) {
        this.resourceStore.setResourceError(key, error);
      }

      for (const key of requestedKeys) {
        if (returnedKeys.has(key) || errorKeys.has(key)) continue;

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
      }
    } catch (error) {
      const aborted =
        options.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError");
      for (const key of requestedKeys) {
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
          const normalized = error instanceof Error
            ? error
            : new Error(String(error));
          this.resourceStore.setResourceError(key, {
            type: normalized.name || "ResourceError",
            message: normalized.message,
          });
        }
      }
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
    this.emitResourceUpdates(this.resourceStore.setMany(envelope.resources));
    this.pageCache.set(envelope.page, this.resourceStore.exportKnownVersions());
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
      });

      for (const [key, patches] of Object.entries(
        envelope.mutation.patches ?? {}
      )) {
        if (this.resourceStore.patch(key, patches)) {
          const version = this.resourceStore.getRecord(key)?.version ?? "";
          this.events.emit("resource:update", { key, version });
        }
      }

      const activeInvalidations: string[] = [];
      for (const key of envelope.mutation.invalidate ?? []) {
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
        await this.refresh({ only: activeInvalidations });
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
    this.abortActiveVisit();
    this.resourceStore.clear();
    this.pageStore.clear();
    this.pageCache.clear();
    this.prefetchManager.clear();
  }

  destroy(): void {
    this.abortActiveVisit();
    this.stopHistory();
    this.history.destroy();
    this.events.removeAllListeners();
  }

  private applyPageEnvelope(envelope: PageEnvelope): void {
    this.emitResourceUpdates(this.resourceStore.setMany(envelope.resources));
    this.pageStore.setPage(envelope.page);
    this.pageCache.set(envelope.page, this.resourceStore.exportKnownVersions());
  }

  private emitResourceUpdates(keys: string[]): void {
    for (const key of keys) {
      const version = this.resourceStore.getRecord(key)?.version ?? "";
      this.events.emit("resource:update", { key, version });
    }
  }

  private abortActiveVisit(): void {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
    this.currentVisitId = null;
  }
}

export function createFluxRuntime(options: FluxRuntimeOptions = {}): FluxRouter {
  return new FluxRouter(options);
}
