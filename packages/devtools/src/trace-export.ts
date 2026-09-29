import { deriveCacheInsights, deriveMutationHistory } from "./cache-mutations.js";
import { deriveDevtoolsInsights } from "./insights.js";
import { deriveLiveInsights, deriveProtocolRequest } from "./live-protocol.js";
import type { DevtoolsSnapshot } from "./store.js";
import { deriveTimeline } from "./timeline.js";

export const DEVTOOLS_EXPORT_FORMAT = "fluxfast-devtools-export/1";

/** Serialize only the bounded, value-free projections already used by the UI. */
export function createSafeTraceExport(
  snapshot: DevtoolsSnapshot,
  createdAt: number = Date.now()
): string {
  const insights = deriveDevtoolsInsights(snapshot);
  const timeline = deriveTimeline(snapshot.events).map(item => ({
    id: item.id,
    sourceEventId: item.sourceEventId,
    timestamp: item.timestamp,
    category: item.primaryCategory,
    categories: item.categories,
    label: item.label,
    summary: item.summary,
    detail: item.detail,
    correlationId: item.correlationId,
    durationMs: item.durationMs,
    waterfall: item.waterfall,
  }));
  const safeCreatedAt = Number.isFinite(createdAt) && createdAt >= 0
    ? createdAt
    : 0;
  return JSON.stringify({
    format: DEVTOOLS_EXPORT_FORMAT,
    createdAt: new Date(safeCreatedAt).toISOString(),
    page: snapshot.page,
    live: {
      ...snapshot.live,
      resourceCount: snapshot.liveResourceCount,
    },
    overview: insights.overview,
    resources: insights.resources,
    timeline,
    cache: deriveCacheInsights(snapshot.events),
    mutations: deriveMutationHistory(snapshot.events),
    liveDiagnostics: deriveLiveInsights(snapshot.events),
    protocol: deriveProtocolRequest(snapshot.events),
  }, null, 2);
}
