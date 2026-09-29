"use client";

import React, {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useFluxContext } from "@fluxfast/next";
import {
  deriveDevtoolsInsights,
  formatAge,
  formatDuration,
  formatTtl,
  type DevtoolsResourceInsight,
} from "./insights.js";
import { DevtoolsStore, DEFAULT_MAX_EVENTS } from "./store.js";
import { DEVTOOLS_STYLES } from "./styles.js";

export interface FluxDevtoolsProps {
  position?: "bottom" | "right";
  theme?: "system" | "light" | "dark";
  defaultOpen?: boolean;
  maxEvents?: number;
  shortcut?: string | false;
}

interface BoundaryState {
  failed: boolean;
}

type PanelName = "overview" | "resources";

class DevtoolsErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[fluxfast/devtools] DevTools disabled after an internal error", {
      name: error.name,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ff-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ResourceFlags({ resource }: { resource: DevtoolsResourceInsight }) {
  const flags = [
    resource.stale ? "stale" : undefined,
    resource.hasSubscribers ? "subscribed" : undefined,
    resource.deferred ? "deferred" : undefined,
    resource.live ? "live" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  return flags.length > 0 ? <>{flags.join(", ")}</> : <>—</>;
}

function ResourceDetails({
  resource,
  onClose,
}: {
  resource: DevtoolsResourceInsight;
  onClose: () => void;
}) {
  return (
    <section
      className="ff-resource-detail"
      aria-label={`${resource.key} details`}
    >
      <header className="ff-detail-heading">
        <div>
          <p className="ff-eyebrow">Resource detail</p>
          <h3>{resource.key}</h3>
        </div>
        <button type="button" className="ff-secondary-button" onClick={onClose}>
          Close
        </button>
      </header>
      <dl className="ff-detail-list">
        <Metric label="Version" value={resource.version ?? "—"} />
        <Metric label="State" value={resource.status} />
        <Metric label="Stale" value={resource.stale ? "yes" : "no"} />
        <Metric
          label="Last updated"
          value={
            resource.updatedAt === null
              ? "—"
              : `${formatAge(resource.updatedAt)} (${new Date(resource.updatedAt).toLocaleString()})`
          }
        />
        <Metric
          label="Subscribers"
          value={resource.hasSubscribers ? "active" : "none"}
        />
        <Metric label="Server result" value={resource.serverResult ?? "—"} />
        <Metric
          label="Resource duration"
          value={formatDuration(resource.durationMs)}
        />
        <Metric label="Cache backend" value={resource.cacheBackend ?? "—"} />
        <Metric label="Cache result" value={resource.cacheResult ?? "—"} />
        <Metric label="Cache duration" value={formatDuration(resource.cacheMs)} />
        <Metric
          label="Loader duration"
          value={formatDuration(resource.loaderMs)}
        />
        <Metric label="Scope" value={resource.scope ?? "—"} />
        <Metric label="TTL" value={formatTtl(resource.ttl)} />
        <Metric label="Deferred" value={resource.deferred ? "yes" : "no"} />
        <Metric label="Live" value={resource.live ? "yes" : "no"} />
        <Metric
          label="Last update reason"
          value={resource.lastUpdateReason ?? "—"}
        />
        <Metric label="Error type" value={resource.errorType ?? "—"} />
      </dl>
    </section>
  );
}

function FluxDevtoolsInner({
  position = "bottom",
  theme = "system",
  defaultOpen = false,
  maxEvents = DEFAULT_MAX_EVENTS,
}: FluxDevtoolsProps) {
  const { router } = useFluxContext();
  const store = useMemo(
    () => new DevtoolsStore(router, maxEvents),
    [router, maxEvents]
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  const [mountNode, setMountNode] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [activePanel, setActivePanel] = useState<PanelName>("overview");
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const insights = useMemo(() => deriveDevtoolsInsights(snapshot), [snapshot]);
  const selected = insights.resources.find(
    resource => resource.key === selectedResource
  );

  useEffect(() => store.start(), [store]);

  useEffect(() => {
    let host: HTMLDivElement | undefined;
    try {
      host = document.createElement("div");
      host.dataset.fluxfastDevtoolsHost = "";
      const shadow = host.attachShadow({ mode: "open" });
      const mount = document.createElement("div");
      shadow.append(mount);
      document.body.append(host);
      setMountNode(mount);
    } catch (error) {
      console.error("[fluxfast/devtools] Unable to create the isolated host", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }

    return () => {
      setMountNode(null);
      host?.remove();
    };
  }, []);

  if (mountNode === null) return null;

  return createPortal(
    <>
      <style>{DEVTOOLS_STYLES}</style>
      <aside
        className={`ff-devtools ff-${position}`}
        data-theme={theme}
        aria-label="FluxFast DevTools"
      >
        {open && (
          <section
            id="fluxfast-devtools-panel"
            className="ff-panel"
            aria-label="FluxFast diagnostic panels"
          >
            <header className="ff-panel-heading">
              <div>
                <p className="ff-eyebrow">Development diagnostics</p>
                <h2 className="ff-panel-title">FluxFast DevTools</h2>
              </div>
              <span className="ff-recording">
                {snapshot.events.length} recorded events
              </span>
            </header>
            <div
              className="ff-tabs"
              role="tablist"
              aria-label="Diagnostic panels"
            >
              {(["overview", "resources"] as const).map(panel => (
                <button
                  key={panel}
                  type="button"
                  role="tab"
                  id={`fluxfast-tab-${panel}`}
                  aria-controls={`fluxfast-panel-${panel}`}
                  aria-selected={activePanel === panel}
                  className="ff-tab"
                  onClick={() => setActivePanel(panel)}
                >
                  {panel === "overview" ? "Overview" : "Resources"}
                </button>
              ))}
            </div>

            <div
              id="fluxfast-panel-overview"
              role="tabpanel"
              aria-labelledby="fluxfast-tab-overview"
              className="ff-tab-panel"
              hidden={activePanel !== "overview"}
            >
              <section className="ff-context-grid" aria-label="Current page">
                <div className="ff-context-card">
                  <span>Route</span>
                  <strong title={snapshot.page.url}>{snapshot.page.url}</strong>
                </div>
                <div className="ff-context-card">
                  <span>Component</span>
                  <strong title={snapshot.page.component || undefined}>
                    {snapshot.page.component || "—"}
                  </strong>
                </div>
                <div className="ff-context-card">
                  <span>Latest request</span>
                  <strong>
                    {formatDuration(insights.overview.latestRequestMs)}
                  </strong>
                </div>
                <div className="ff-context-card">
                  <span>Client session</span>
                  <strong title={snapshot.clientId}>
                    {snapshot.clientId || "—"}
                  </strong>
                </div>
              </section>

              <section
                className="ff-summary-section"
                aria-labelledby="ff-resource-summary"
              >
                <h3 id="ff-resource-summary">Resources</h3>
                <dl className="ff-metric-grid">
                  <Metric
                    label="Total"
                    value={insights.overview.totalResources}
                  />
                  <Metric
                    label="Ready"
                    value={insights.overview.readyResources}
                  />
                  <Metric
                    label="Stale"
                    value={insights.overview.staleResources}
                  />
                  <Metric
                    label="Pending"
                    value={insights.overview.pendingResources}
                  />
                  <Metric
                    label="Error"
                    value={insights.overview.errorResources}
                  />
                </dl>
              </section>

              <section
                className="ff-summary-section"
                aria-labelledby="ff-runtime-summary"
              >
                <h3 id="ff-runtime-summary">Runtime</h3>
                <dl className="ff-metric-grid">
                  <Metric
                    label="Cache hits"
                    value={insights.overview.cacheHits}
                  />
                  <Metric
                    label="Cache misses"
                    value={insights.overview.cacheMisses}
                  />
                  <Metric
                    label="Deferred"
                    value={insights.overview.deferredResources}
                  />
                  <Metric
                    label="Live resources"
                    value={insights.overview.liveResources}
                  />
                  <Metric label="Live status" value={snapshot.live.status} />
                </dl>
              </section>
            </div>

            <div
              id="fluxfast-panel-resources"
              role="tabpanel"
              aria-labelledby="fluxfast-tab-resources"
              className="ff-tab-panel"
              hidden={activePanel !== "resources"}
            >
              {insights.resources.length === 0 ? (
                <p className="ff-empty">
                  No resources are currently registered.
                </p>
              ) : (
                <div
                  className="ff-table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Resource metadata table"
                >
                  <table className="ff-table">
                    <caption>Value-free resource runtime metadata</caption>
                    <thead>
                      <tr>
                        <th scope="col">Resource</th>
                        <th scope="col">Status</th>
                        <th scope="col">Source</th>
                        <th scope="col">Version</th>
                        <th scope="col">Age</th>
                        <th scope="col">Flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insights.resources.map(resource => (
                        <tr
                          key={resource.key}
                          data-selected={
                            selectedResource === resource.key || undefined
                          }
                          onClick={() => setSelectedResource(resource.key)}
                        >
                          <th scope="row">
                            <button
                              type="button"
                              className="ff-resource-button"
                              aria-label={`Inspect ${resource.key}`}
                              onClick={() => setSelectedResource(resource.key)}
                            >
                              {resource.key}
                            </button>
                          </th>
                          <td>
                            <span
                              className={`ff-status ff-status-${resource.status}`}
                            >
                              {resource.status}
                            </span>
                          </td>
                          <td>{resource.source}</td>
                          <td
                            className="ff-truncate"
                            title={resource.version ?? undefined}
                          >
                            {resource.version ?? "—"}
                          </td>
                          <td>{formatAge(resource.updatedAt)}</td>
                          <td>
                            <ResourceFlags resource={resource} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {selected && (
                <ResourceDetails
                  resource={selected}
                  onClose={() => setSelectedResource(null)}
                />
              )}
            </div>
          </section>
        )}
        <button
          type="button"
          className="ff-bar"
          aria-expanded={open}
          aria-controls="fluxfast-devtools-panel"
          aria-label={`${open ? "Close" : "Open"} FluxFast DevTools`}
          onClick={() => setOpen(value => !value)}
        >
          <span className="ff-brand">FluxFast</span>
          <span className="ff-route">{snapshot.page.url}</span>
          <span className="ff-bar-stat">
            {insights.overview.totalResources} Resources
          </span>
          <span className="ff-bar-stat">
            H{insights.overview.cacheHits} M{insights.overview.cacheMisses}
          </span>
          <span className="ff-bar-stat">D{insights.overview.deferredResources}</span>
          <span className="ff-bar-stat">Live {insights.overview.liveResources}</span>
          <span className="ff-bar-stat">
            {formatDuration(insights.overview.latestRequestMs)}
          </span>
          <span
            className={`ff-bar-stat${insights.overview.errorCount > 0 ? " ff-errors" : ""}`}
          >
            {insights.overview.errorCount} errors
          </span>
          <span className="ff-count">{open ? "Close" : "Open"}</span>
        </button>
      </aside>
    </>,
    mountNode
  );
}

/** Mount the development-only FluxFast diagnostics UI. */
export function FluxDevtools(
  props: FluxDevtoolsProps
): React.ReactElement | null {
  if (process.env.NODE_ENV === "production") return null;
  return (
    <DevtoolsErrorBoundary>
      <FluxDevtoolsInner {...props} />
    </DevtoolsErrorBoundary>
  );
}
