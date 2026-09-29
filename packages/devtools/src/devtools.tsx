"use client";

import React, {
  Component,
  type CSSProperties,
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
import {
  DevtoolsStore,
  DEFAULT_MAX_EVENTS,
  type DevtoolsSnapshot,
} from "./store.js";
import { DEVTOOLS_STYLES } from "./styles.js";
import {
  deriveTimeline,
  filterTimeline,
  formatTimelineTime,
  TIMELINE_FILTERS,
  type TimelineCategory,
  type TimelineItem,
  type TimelineWaterfallPhase,
} from "./timeline.js";
import {
  deriveCacheInsights,
  deriveMutationHistory,
  mutationResultLabel,
  serverCacheResultLabel,
  type MutationInsight,
} from "./cache-mutations.js";
import {
  abbreviatedVersion,
  deriveLiveInsights,
  deriveProtocolRequest,
} from "./live-protocol.js";

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

type PanelName =
  | "overview"
  | "resources"
  | "timeline"
  | "cache"
  | "mutations"
  | "live"
  | "protocol";

const PANELS: readonly PanelName[] = Object.freeze([
  "overview",
  "resources",
  "timeline",
  "cache",
  "mutations",
  "live",
  "protocol",
]);

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

function Waterfall({ phases }: { phases: readonly TimelineWaterfallPhase[] }) {
  const total = Math.max(
    1,
    ...phases.map(item => item.offsetMs + item.durationMs)
  );
  return (
    <section className="ff-waterfall" aria-labelledby="ff-waterfall-title">
      <h3 id="ff-waterfall-title">Request waterfall</h3>
      <ol>
        {phases.map((item, index) => {
          const style = {
            "--ff-waterfall-offset": `${item.offsetMs / total * 100}%`,
            "--ff-waterfall-duration": `${Math.max(1, item.durationMs / total * 100)}%`,
          } as CSSProperties;
          return (
            <li key={`${item.label}-${index}`}>
              <span title={item.label}>{item.label}</span>
              <span className="ff-waterfall-track" aria-hidden="true">
                <span className="ff-waterfall-bar" style={style} />
              </span>
              <strong>{formatDuration(item.durationMs)}</strong>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TimelineRow({
  item,
  selected,
  correlated,
  onSelect,
}: {
  item: TimelineItem;
  selected: boolean;
  correlated: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="ff-timeline-row"
        data-selected={selected || undefined}
        data-correlated={correlated || undefined}
        data-error={item.categories.includes("error") || undefined}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <time dateTime={new Date(item.timestamp).toISOString()}>
          {formatTimelineTime(item.timestamp)}
        </time>
        <span className={`ff-timeline-category ff-category-${item.primaryCategory}`}>
          {item.label}
        </span>
        <span className="ff-timeline-summary">
          <strong>{item.summary || "observation"}</strong>
          {item.detail && <small>{item.detail}</small>}
        </span>
        <span className="ff-timeline-duration">
          {formatDuration(item.durationMs)}
        </span>
      </button>
    </li>
  );
}

function TimelinePanel({
  snapshot,
  store,
}: {
  snapshot: DevtoolsSnapshot;
  store: DevtoolsStore;
}) {
  const [filters, setFilters] = useState<readonly TimelineCategory[]>([]);
  const [query, setQuery] = useState("");
  const items = useMemo(() => deriveTimeline(snapshot.events), [snapshot.events]);
  const visible = useMemo(
    () => filterTimeline(items, filters, query),
    [items, filters, query]
  );
  const selectedItem = items.find(
    item => item.sourceEventId === snapshot.selectedEventId
  );
  const selectedCorrelation = selectedItem?.correlationId ?? null;
  const waterfall = selectedCorrelation === null
    ? selectedItem?.waterfall
    : items.find(item => (
        item.correlationId === selectedCorrelation && item.waterfall.length > 0
      ))?.waterfall;

  const toggleFilter = (category: TimelineCategory) => {
    setFilters(current => current.includes(category)
      ? current.filter(item => item !== category)
      : [...current, category]);
  };

  return (
    <>
      <div className="ff-timeline-controls">
        <label className="ff-search-label">
          <span>Search timeline</span>
          <input
            type="search"
            value={query}
            maxLength={256}
            placeholder="Resource, route, or operation"
            onChange={event => setQuery(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="ff-secondary-button"
          disabled={snapshot.events.length === 0}
          onClick={() => store.clearTimeline()}
        >
          Clear
        </button>
      </div>
      <div className="ff-filter-list" aria-label="Timeline filters">
        {TIMELINE_FILTERS.map(category => (
          <button
            key={category}
            type="button"
            className="ff-filter"
            aria-pressed={filters.includes(category)}
            onClick={() => toggleFilter(category)}
          >
            {category}
          </button>
        ))}
      </div>
      <div className="ff-timeline-meta" aria-live="polite">
        <span>Showing {visible.length} of {items.length}</span>
        {selectedCorrelation && (
          <span title={selectedCorrelation}>
            Correlation: {selectedCorrelation}
          </span>
        )}
      </div>
      {waterfall && waterfall.length > 0 && <Waterfall phases={waterfall} />}
      {visible.length === 0 ? (
        <p className="ff-empty">
          {items.length === 0
            ? "No diagnostic events recorded yet."
            : "No events match the current filters."}
        </p>
      ) : (
        <ol className="ff-timeline" aria-label="Diagnostic event timeline">
          {visible.map(item => {
            const selected = item.id === snapshot.selectedEventId;
            const sourceSelected =
              item.sourceEventId === snapshot.selectedEventId;
            const correlated = selectedCorrelation !== null &&
              item.correlationId === selectedCorrelation;
            return (
              <TimelineRow
                key={item.id}
                item={item}
                selected={selected}
                correlated={correlated}
                onSelect={() => store.selectEvent(sourceSelected
                  ? null
                  : item.sourceEventId)}
              />
            );
          })}
        </ol>
      )}
    </>
  );
}

function CachePanel({ snapshot }: { snapshot: DevtoolsSnapshot }) {
  const insights = useMemo(
    () => deriveCacheInsights(snapshot.events),
    [snapshot.events]
  );
  const server = insights.server;

  return (
    <>
      <p className="ff-panel-intro">
        Browser cache observations describe page-envelope reuse in this tab.
        Server cache observations come from the latest backend request and do
        not inspect Redis itself.
      </p>
      <section className="ff-inspector-section" aria-labelledby="ff-server-cache">
        <header className="ff-section-heading">
          <div>
            <p className="ff-eyebrow">Backend observation</p>
            <h3 id="ff-server-cache">Server resource cache</h3>
          </div>
          {server && (
            <span title={server.path}>
              {server.path} · {formatDuration(server.durationMs)}
            </span>
          )}
        </header>
        {server === null ? (
          <p className="ff-empty">
            No server resource-cache trace has been received yet.
          </p>
        ) : (
          <>
            <dl className="ff-metric-grid ff-cache-metrics">
              <Metric
                label="Hit ratio"
                value={`${server.hitCount} / ${server.lookupCount}`}
              />
              <Metric
                label="Redis"
                value={server.redisActive ? "active" : "not observed"}
              />
              <Metric
                label="Known-version omissions"
                value={server.knownVersionOmissions}
              />
              <Metric
                label="Trace"
                value={server.truncated ? "truncated" : "complete"}
              />
            </dl>
            {server.resources.length === 0 ? (
              <p className="ff-empty ff-section-empty">
                The latest request had no server resource observations.
              </p>
            ) : (
              <div
                className="ff-table-scroll ff-cache-table"
                tabIndex={0}
                role="region"
                aria-label="Latest server resource-cache observations"
              >
                <table className="ff-table">
                  <caption>Latest server resource-cache observations</caption>
                  <thead>
                    <tr>
                      <th scope="col">Resource</th>
                      <th scope="col">Result</th>
                      <th scope="col">Backend</th>
                      <th scope="col">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {server.resources.map((resource, index) => (
                      <tr key={`${resource.key}-${index}`}>
                        <th scope="row">{resource.key}</th>
                        <td>
                          <span
                            className={`ff-cache-result ff-cache-${resource.cacheResult}`}
                          >
                            {serverCacheResultLabel(resource)}
                          </span>
                        </td>
                        <td>{resource.backend}</td>
                        <td>{formatDuration(resource.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="ff-inspector-section" aria-labelledby="ff-browser-cache">
        <header className="ff-section-heading">
          <div>
            <p className="ff-eyebrow">Client observation</p>
            <h3 id="ff-browser-cache">Browser page cache</h3>
          </div>
          <span>{insights.browser.observations.length} recent events</span>
        </header>
        <dl className="ff-metric-grid ff-browser-cache-metrics">
          <Metric label="Hits" value={insights.browser.hits} />
          <Metric label="Misses" value={insights.browser.misses} />
          <Metric label="Writes" value={insights.browser.writes} />
        </dl>
        {insights.browser.observations.length === 0 ? (
          <p className="ff-empty ff-section-empty">
            No browser page-cache activity has been observed yet.
          </p>
        ) : (
          <ol className="ff-cache-observations" aria-label="Browser page-cache activity">
            {insights.browser.observations.map(observation => (
              <li key={observation.id}>
                <time dateTime={new Date(observation.timestamp).toISOString()}>
                  {formatTimelineTime(observation.timestamp)}
                </time>
                <strong className={`ff-cache-${observation.action}`}>
                  {observation.action.toLocaleUpperCase()}
                </strong>
                <span>{observation.source}</span>
                <code title={observation.path}>{observation.path}</code>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="ff-scope-note">
        Redis keys, memory, databases, connection strings, and command traffic
        are intentionally outside FluxFast DevTools.
      </p>
    </>
  );
}

function MutationDetails({ mutation }: { mutation: MutationInsight }) {
  const result = mutationResultLabel(mutation);
  return (
    <section
      className="ff-mutation-detail"
      aria-label={`${mutation.method} ${mutation.path} details`}
    >
      <header className="ff-detail-heading">
        <div>
          <p className="ff-eyebrow">Selected mutation</p>
          <h3>{mutation.method} {mutation.path}</h3>
        </div>
        <span className={`ff-status ff-status-${mutation.result}`}>
          {result}
        </span>
      </header>
      <dl className="ff-detail-list ff-mutation-summary">
        <Metric label="Request" value={`${mutation.method} ${mutation.path}`} />
        <Metric label="Result" value={result} />
        <Metric label="Duration" value={formatDuration(mutation.durationMs)} />
        <Metric label="Live" value={`${mutation.liveSignals} events`} />
        <Metric label="Redirect" value={mutation.redirect} />
        <Metric label="Handler" value={formatDuration(mutation.handlerMs)} />
        <Metric
          label="Invalidation"
          value={formatDuration(mutation.invalidationMs)}
        />
        <Metric label="Serialize" value={formatDuration(mutation.serializeMs)} />
      </dl>
      {mutation.errorType && (
        <p className="ff-inline-error">Error type: {mutation.errorType}</p>
      )}
      {mutation.truncated && (
        <p className="ff-trace-warning">
          The server trace reached its metadata limit; counts may exceed the
          visible keys below.
        </p>
      )}
      <div className="ff-mutation-columns">
        <section aria-labelledby="ff-selected-mutation-patches">
          <h4 id="ff-selected-mutation-patches">Patches</h4>
          {mutation.patches.length === 0 ? (
            <p>None</p>
          ) : (
            <ul className="ff-key-list">
              {mutation.patches.map(patch => (
                <li key={patch.key}>
                  <strong>{patch.key}</strong>
                  <span>
                    {patch.operations.length === 0
                      ? "operation metadata unavailable"
                      : patch.operations.map(operation => (
                          `${operation.name} ×${operation.count}`
                        )).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="ff-selected-mutation-invalidations">
          <h4 id="ff-selected-mutation-invalidations">
            Invalidations ({mutation.invalidationCount})
          </h4>
          {mutation.invalidated.length === 0 ? (
            <p>None</p>
          ) : (
            <ul className="ff-key-list">
              {mutation.invalidated.map((key, index) => (
                <li key={`${key}-${index}`}><strong>{key}</strong></li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <p className="ff-scope-note">
        Request bodies and resource values are never collected by this panel.
      </p>
    </section>
  );
}

function MutationsPanel({ snapshot }: { snapshot: DevtoolsSnapshot }) {
  const mutations = useMemo(
    () => deriveMutationHistory(snapshot.events),
    [snapshot.events]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = mutations.find(mutation => mutation.id === selectedId) ??
    mutations[0];

  if (mutations.length === 0) {
    return (
      <p className="ff-empty">
        No mutations have been observed in this DevTools session.
      </p>
    );
  }

  return (
    <div className="ff-mutations-layout">
      <section aria-labelledby="ff-mutation-history">
        <header className="ff-section-heading">
          <div>
            <p className="ff-eyebrow">Bounded history</p>
            <h3 id="ff-mutation-history">Recent mutations</h3>
          </div>
          <span>{mutations.length} recorded</span>
        </header>
        <ol className="ff-mutation-list">
          {mutations.map(mutation => (
            <li key={mutation.id}>
              <button
                type="button"
                aria-pressed={mutation.id === selected?.id}
                onClick={() => setSelectedId(mutation.id)}
              >
                <span className="ff-mutation-request">
                  <strong>{mutation.method}</strong>
                  <span title={mutation.path}>{mutation.path}</span>
                </span>
                <span
                  className={`ff-mutation-result ff-status-${mutation.result}`}
                >
                  {mutationResultLabel(mutation)}
                </span>
                <span>{formatDuration(mutation.durationMs)}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
      {selected && <MutationDetails mutation={selected} />}
    </div>
  );
}

function LivePanel({ snapshot }: { snapshot: DevtoolsSnapshot }) {
  const insights = useMemo(
    () => deriveLiveInsights(snapshot.events),
    [snapshot.events]
  );
  const lastEvent = insights.lastEvent;

  return (
    <>
      <p className="ff-panel-intro">
        This panel observes the existing LiveManager connection and its
        canonical refreshes. It does not create a second connection or live
        state machine.
      </p>
      <dl className="ff-metric-grid ff-live-metrics">
        <Metric
          label="Connection status"
          value={(
            <span className={`ff-live-status ff-live-${snapshot.live.status}`}>
              {snapshot.live.status}
            </span>
          )}
        />
        <Metric label="Connected resources" value={snapshot.liveResourceCount} />
        <Metric
          label="Reconnect attempts"
          value={insights.reconnectCount}
        />
        <Metric
          label="Last live event"
          value={lastEvent
            ? `${lastEvent.label} · ${formatAge(lastEvent.timestamp)}`
            : snapshot.live.lastEventAt === null
              ? "—"
              : formatAge(snapshot.live.lastEventAt)}
        />
        <Metric label="Resync count" value={insights.resyncCount} />
        <Metric
          label="Queue overflow count"
          value={insights.queueOverflowCount}
        />
      </dl>
      <section className="ff-inspector-section" aria-labelledby="ff-live-timeline">
        <header className="ff-section-heading">
          <div>
            <p className="ff-eyebrow">Connection and synchronization</p>
            <h3 id="ff-live-timeline">Live timeline</h3>
          </div>
          <span>
            Current attempt {snapshot.live.reconnectAttempt}
          </span>
        </header>
        {insights.observations.length === 0 ? (
          <p className="ff-empty">
            No live connection or synchronization events recorded yet.
          </p>
        ) : (
          <ol className="ff-live-timeline" aria-label="Live synchronization timeline">
            {insights.observations.map(observation => (
              <li key={observation.id} data-error={observation.error || undefined}>
                <time dateTime={new Date(observation.timestamp).toISOString()}>
                  {formatTimelineTime(observation.timestamp)}
                </time>
                <span className="ff-live-marker" aria-hidden="true" />
                <span className="ff-live-event">
                  <strong>{observation.label}</strong>
                  {observation.detail && <small>{observation.detail}</small>}
                </span>
                <span className="ff-live-meta">
                  {observation.keyCount === null
                    ? "—"
                    : `${observation.keyCount} resources`}
                  {observation.reconnectAttempt === null
                    ? ""
                    : ` · attempt ${observation.reconnectAttempt}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function ProtocolPanel({ snapshot }: { snapshot: DevtoolsSnapshot }) {
  const request = useMemo(
    () => deriveProtocolRequest(snapshot.events),
    [snapshot.events]
  );

  if (request === null) {
    return (
      <p className="ff-empty">
        No FluxFast transport request has been observed yet.
      </p>
    );
  }

  const response = request.response;
  return (
    <>
      {request.serverTrace === "unsupported" && (
        <p className="ff-protocol-warning" role="status">
          Unsupported DevTools trace version
          {request.diagnosticProtocol ? `: ${request.diagnosticProtocol}` : "."}
          {" "}The FluxFast request continued normally.
        </p>
      )}
      {request.serverTrace === "invalid" && (
        <p className="ff-protocol-warning" role="status">
          Invalid DevTools trace metadata was ignored. The FluxFast request
          continued normally.
        </p>
      )}
      <section className="ff-context-grid ff-protocol-context" aria-label="Latest request">
        <div className="ff-context-card">
          <span>Request</span>
          <strong title={`${request.method} ${request.path}`}>
            {request.method} {request.path}
          </strong>
        </div>
        <div className="ff-context-card">
          <span>Result</span>
          <strong className={`ff-status-${request.status}`}>
            {request.status}
            {request.httpStatus === null ? "" : ` · HTTP ${request.httpStatus}`}
          </strong>
        </div>
        <div className="ff-context-card">
          <span>Duration</span>
          <strong>{formatDuration(request.durationMs)}</strong>
        </div>
        <div className="ff-context-card">
          <span>Source</span>
          <strong>{request.source === "ssr" ? "initial SSR" : "browser"}</strong>
        </div>
      </section>

      <section className="ff-inspector-section" aria-labelledby="ff-protocol-versions">
        <header className="ff-section-heading">
          <div>
            <p className="ff-eyebrow">Version-independent contracts</p>
            <h3 id="ff-protocol-versions">Protocols</h3>
          </div>
          <span>{request.requestType} request</span>
        </header>
        <dl className="ff-detail-list ff-protocol-versions">
          <Metric label="Application protocol" value={request.protocol ?? "—"} />
          <Metric
            label="DevTools protocol"
            value={request.diagnosticProtocol ?? "—"}
          />
          <Metric label="Trace status" value={request.serverTrace} />
          <Metric label="Trace body" value={request.truncated ? "truncated" : "complete"} />
        </dl>
      </section>

      <section className="ff-protocol-grid">
        <section aria-labelledby="ff-capabilities">
          <h3 id="ff-capabilities">Capabilities</h3>
          {request.capabilities.length === 0 ? (
            <p className="ff-protocol-empty">—</p>
          ) : (
            <ul className="ff-token-list">
              {request.capabilities.map(capability => (
                <li key={capability}>{capability}</li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="ff-only-resources">
          <h3 id="ff-only-resources">Only</h3>
          {request.only.length === 0 ? (
            <p className="ff-protocol-empty">—</p>
          ) : (
            <ul className="ff-token-list">
              {request.only.map(key => <li key={key}>{key}</li>)}
            </ul>
          )}
        </section>
      </section>

      <section className="ff-inspector-section" aria-labelledby="ff-known-versions">
        <header className="ff-section-heading">
          <div>
            <p className="ff-eyebrow">Request optimization</p>
            <h3 id="ff-known-versions">Known versions</h3>
          </div>
          <span>{request.knownVersions.length} advertised</span>
        </header>
        {request.knownVersions.length === 0 ? (
          <p className="ff-empty">No known resource versions were advertised.</p>
        ) : (
          <div
            className="ff-table-scroll ff-known-versions"
            tabIndex={0}
            role="region"
            aria-label="Known resource versions"
          >
            <table className="ff-table">
              <caption>Known resource versions sent by FluxFast</caption>
              <thead>
                <tr>
                  <th scope="col">Resource</th>
                  <th scope="col">Version</th>
                </tr>
              </thead>
              <tbody>
                {request.knownVersions.map(item => (
                  <tr key={item.key}>
                    <th scope="row">{item.key}</th>
                    <td title={item.version}>{abbreviatedVersion(item.version)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ff-inspector-section" aria-labelledby="ff-protocol-response">
        <header className="ff-section-heading">
          <div>
            <p className="ff-eyebrow">Safe response metadata</p>
            <h3 id="ff-protocol-response">Response</h3>
          </div>
        </header>
        {request.requestType === "page" ? (
          <dl className="ff-metric-grid ff-response-metrics">
            <Metric label="Observed" value={response.resourceObservations} />
            <Metric label="Resources sent" value={response.resourcesSent} />
            <Metric label="Resources omitted" value={response.resourcesOmitted} />
            <Metric label="Deferred" value={response.deferred} />
            <Metric label="Errors" value={response.errors} />
          </dl>
        ) : (
          <dl className="ff-metric-grid ff-response-metrics">
            <Metric label="Patch resources" value={response.patchResources} />
            <Metric label="Invalidations" value={response.invalidations} />
            <Metric label="Live signals" value={response.liveSignals} />
          </dl>
        )}
      </section>
      <p className="ff-scope-note">
        Cookies, authorization, CSRF tokens, custom headers, request bodies,
        and resource values are intentionally excluded.
      </p>
    </>
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
              {PANELS.map(panel => (
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
                  {panel[0].toLocaleUpperCase() + panel.slice(1)}
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

            <div
              id="fluxfast-panel-timeline"
              role="tabpanel"
              aria-labelledby="fluxfast-tab-timeline"
              className="ff-tab-panel"
              hidden={activePanel !== "timeline"}
            >
              {activePanel === "timeline" && (
                <TimelinePanel snapshot={snapshot} store={store} />
              )}
            </div>

            <div
              id="fluxfast-panel-cache"
              role="tabpanel"
              aria-labelledby="fluxfast-tab-cache"
              className="ff-tab-panel"
              hidden={activePanel !== "cache"}
            >
              {activePanel === "cache" && <CachePanel snapshot={snapshot} />}
            </div>

            <div
              id="fluxfast-panel-mutations"
              role="tabpanel"
              aria-labelledby="fluxfast-tab-mutations"
              className="ff-tab-panel"
              hidden={activePanel !== "mutations"}
            >
              {activePanel === "mutations" && (
                <MutationsPanel snapshot={snapshot} />
              )}
            </div>

            <div
              id="fluxfast-panel-live"
              role="tabpanel"
              aria-labelledby="fluxfast-tab-live"
              className="ff-tab-panel"
              hidden={activePanel !== "live"}
            >
              {activePanel === "live" && <LivePanel snapshot={snapshot} />}
            </div>

            <div
              id="fluxfast-panel-protocol"
              role="tabpanel"
              aria-labelledby="fluxfast-tab-protocol"
              className="ff-tab-panel"
              hidden={activePanel !== "protocol"}
            >
              {activePanel === "protocol" && (
                <ProtocolPanel snapshot={snapshot} />
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
