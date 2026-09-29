import type {
  FluxDiagnosticEvent,
  FluxRouter,
  LiveStatusSnapshot,
  ResourceMetadataSnapshot,
} from "@fluxfast/core";

export const DEFAULT_MAX_EVENTS = 500;
export const HARD_MAX_EVENTS = 5_000;

export interface DevtoolsPageSnapshot {
  readonly component: string;
  readonly url: string;
}

export interface DevtoolsSnapshot {
  readonly events: readonly FluxDiagnosticEvent[];
  readonly resources: readonly ResourceMetadataSnapshot[];
  readonly page: DevtoolsPageSnapshot;
  readonly live: LiveStatusSnapshot;
  readonly liveResourceCount: number;
  readonly clientId: string;
}

type StoreListener = () => void;

const EMPTY_PAGE: DevtoolsPageSnapshot = Object.freeze({
  component: "",
  url: "/",
});

const EMPTY_LIVE: LiveStatusSnapshot = Object.freeze({
  status: "idle",
  connected: false,
  reconnectAttempt: 0,
  lastEventAt: null,
});

function safePath(value: string): string {
  try {
    return new URL(value, "http://fluxfast.local").pathname.slice(0, 2_048) || "/";
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 2_048) || "/";
  }
}

function pageSnapshot(router: FluxRouter): DevtoolsPageSnapshot {
  const page = router.pageStore.getSnapshot();
  return Object.freeze({
    component: page.component.slice(0, 2_048),
    url: safePath(page.url || "/"),
  });
}

function validateMaximum(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > HARD_MAX_EVENTS) {
    throw new RangeError(
      `maxEvents must be an integer between 1 and ${HARD_MAX_EVENTS}`
    );
  }
  return value;
}

/** Internal bounded projection of the active FluxFast runtime. */
export class DevtoolsStore {
  private readonly router: FluxRouter;
  private readonly maxEvents: number;
  private readonly listeners = new Set<StoreListener>();
  private events: readonly FluxDiagnosticEvent[] = Object.freeze([]);
  private resources: readonly ResourceMetadataSnapshot[] = Object.freeze([]);
  private page: DevtoolsPageSnapshot = EMPTY_PAGE;
  private live: LiveStatusSnapshot = EMPTY_LIVE;
  private liveResourceCount = 0;
  private snapshot: DevtoolsSnapshot = Object.freeze({
    events: this.events,
    resources: this.resources,
    page: this.page,
    live: this.live,
    liveResourceCount: this.liveResourceCount,
    clientId: "",
  });
  private stopDiagnostics?: () => void;
  private stopResources?: () => void;
  private stopPage?: () => void;
  private stopLive?: () => void;

  constructor(router: FluxRouter, maxEvents: number = DEFAULT_MAX_EVENTS) {
    this.router = router;
    this.maxEvents = validateMaximum(maxEvents);
  }

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DevtoolsSnapshot => this.snapshot;

  start(): () => void {
    if (this.stopDiagnostics) return () => this.stop();

    this.resources = this.router.resourceStore.getRecordsSnapshot();
    this.page = pageSnapshot(this.router);
    this.live = this.router.liveManager.getSnapshot();
    this.liveResourceCount =
      this.router.liveManager.getManifest()?.keys.length ?? 0;
    this.stopDiagnostics = this.router.diagnostics.subscribe(event => {
      const start = Math.max(0, this.events.length - this.maxEvents + 1);
      this.events = Object.freeze([...this.events.slice(start), event]);
      this.publish();
    });
    this.stopResources = this.router.resourceStore.subscribeAll(() => {
      this.resources = this.router.resourceStore.getRecordsSnapshot();
      this.publish();
    });
    this.stopPage = this.router.pageStore.subscribe(() => {
      this.page = pageSnapshot(this.router);
      this.liveResourceCount =
        this.router.liveManager.getManifest()?.keys.length ?? 0;
      this.publish();
      // FluxRouter applies the live manifest immediately after publishing the
      // page. Refresh once that synchronous envelope application has settled.
      queueMicrotask(() => {
        if (!this.stopPage) return;
        const count = this.router.liveManager.getManifest()?.keys.length ?? 0;
        if (count === this.liveResourceCount) return;
        this.liveResourceCount = count;
        this.publish();
      });
    });
    this.stopLive = this.router.liveManager.subscribe(() => {
      this.live = this.router.liveManager.getSnapshot();
      this.liveResourceCount =
        this.router.liveManager.getManifest()?.keys.length ?? 0;
      this.publish();
    });
    this.publish();
    return () => this.stop();
  }

  stop(): void {
    this.stopDiagnostics?.();
    this.stopResources?.();
    this.stopPage?.();
    this.stopLive?.();
    this.stopDiagnostics = undefined;
    this.stopResources = undefined;
    this.stopPage = undefined;
    this.stopLive = undefined;
  }

  clearTimeline(): void {
    if (this.events.length === 0) return;
    this.events = Object.freeze([]);
    this.publish();
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      events: this.events,
      resources: this.resources,
      page: this.page,
      live: this.live,
      liveResourceCount: this.liveResourceCount,
      clientId: this.router.clientId.slice(0, 128),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[fluxfast/devtools] Store listener failed:", error);
      }
    }
  }
}
