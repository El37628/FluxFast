import type {
  FluxDiagnosticEvent,
  FluxRouter,
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
}

type StoreListener = () => void;

const EMPTY_PAGE: DevtoolsPageSnapshot = Object.freeze({
  component: "",
  url: "/",
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
  private snapshot: DevtoolsSnapshot = Object.freeze({
    events: this.events,
    resources: this.resources,
    page: this.page,
  });
  private stopDiagnostics?: () => void;
  private stopResources?: () => void;
  private stopPage?: () => void;

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
      this.publish();
    });
    this.publish();
    return () => this.stop();
  }

  stop(): void {
    this.stopDiagnostics?.();
    this.stopResources?.();
    this.stopPage?.();
    this.stopDiagnostics = undefined;
    this.stopResources = undefined;
    this.stopPage = undefined;
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
