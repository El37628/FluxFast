import type { FluxDiagnosticEvent } from "@fluxfast/core";

export type TimelineCategory =
  | "navigation"
  | "resource"
  | "mutation"
  | "cache"
  | "deferred"
  | "live"
  | "error";

export const TIMELINE_FILTERS: readonly TimelineCategory[] = Object.freeze([
  "navigation",
  "resource",
  "mutation",
  "cache",
  "deferred",
  "live",
  "error",
]);

export const MAX_TIMELINE_ITEMS = 5_000;
const MAX_TRACE_RESOURCES = 100;

export interface TimelineWaterfallPhase {
  readonly label: string;
  readonly durationMs: number;
  readonly offsetMs: number;
}

export interface TimelineItem {
  readonly id: string;
  readonly sourceEventId: string;
  readonly timestamp: number;
  readonly primaryCategory: TimelineCategory;
  readonly categories: readonly TimelineCategory[];
  readonly label: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly correlationId: string | null;
  readonly durationMs: number | null;
  readonly waterfall: readonly TimelineWaterfallPhase[];
  readonly searchText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 2_048): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function path(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    return new URL(candidate, "http://fluxfast.local").pathname || "/";
  } catch {
    return candidate.split(/[?#]/, 1)[0] || "/";
  }
}

function words(...values: Array<string | number | undefined>): string {
  return values
    .filter((value): value is string | number => value !== undefined && value !== "")
    .join(" · ");
}

function keySummary(data: Record<string, unknown>): string | undefined {
  const key = text(data.key);
  if (key) return key;
  if (Array.isArray(data.keys)) {
    const keys = data.keys
      .slice(0, 100)
      .map(value => text(value))
      .filter((value): value is string => value !== undefined);
    if (keys.length > 0) {
      const visible = keys.slice(0, 3).join(", ");
      return keys.length > 3 ? `${visible} +${keys.length - 3}` : visible;
    }
  }
  const count = integer(data.keyCount);
  return count === undefined ? undefined : `${count} resources`;
}

function uniqueCategories(
  primary: TimelineCategory,
  additional: readonly TimelineCategory[] = []
): readonly TimelineCategory[] {
  return Object.freeze(Array.from(new Set([primary, ...additional])));
}

function makeItem(
  event: FluxDiagnosticEvent,
  options: {
    id?: string;
    primary: TimelineCategory;
    categories?: readonly TimelineCategory[];
    label: string;
    summary: string;
    detail?: string;
    durationMs?: number;
    waterfall?: readonly TimelineWaterfallPhase[];
  }
): TimelineItem {
  const categories = uniqueCategories(options.primary, options.categories);
  const correlationId = text(event.correlationId, 128) ?? null;
  const detail = options.detail ?? null;
  const durationMs = options.durationMs ?? null;
  const waterfall = Object.freeze([...(options.waterfall ?? [])]);
  const timestamp = Number.isFinite(event.timestamp) && event.timestamp >= 0
    ? event.timestamp
    : 0;
  return Object.freeze({
    id: options.id ?? event.id,
    sourceEventId: event.id,
    timestamp,
    primaryCategory: options.primary,
    categories,
    label: options.label,
    summary: options.summary,
    detail,
    correlationId,
    durationMs,
    waterfall,
    searchText: [
      options.label,
      options.summary,
      detail,
      correlationId,
      ...categories,
    ].filter(Boolean).join(" ").toLocaleLowerCase(),
  });
}

function isError(data: Record<string, unknown>): boolean {
  const phase = text(data.phase, 64);
  return phase === "error" || phase?.endsWith(":error") === true ||
    data.state === "error";
}

function categoriesFromSource(data: Record<string, unknown>): TimelineCategory[] {
  const source = text(data.source, 128);
  if (source?.startsWith("live") || source === "invalidate" || source === "resync") {
    return ["live"];
  }
  if (source?.startsWith("mutation")) return ["mutation"];
  if (source?.includes("deferred")) return ["deferred"];
  return [];
}

function baseEventItem(event: FluxDiagnosticEvent): TimelineItem {
  const data = isRecord(event.data) ? event.data : {};
  const phase = text(data.phase, 64);
  const errorCategories: TimelineCategory[] = isError(data) ? ["error"] : [];
  const url = path(data.url) ?? path(data.path);
  const keys = keySummary(data);

  switch (event.type) {
    case "navigation":
      return makeItem(event, {
        primary: "navigation",
        categories: errorCategories,
        label: "NAVIGATION",
        summary: words(phase, url),
        detail: text(data.component),
      });
    case "resource-load": {
      const reason = text(data.reason, 64);
      const related: TimelineCategory[] = reason?.includes("deferred")
        ? ["deferred"]
        : reason?.startsWith("live")
          ? ["live"]
          : reason === "mutation"
            ? ["mutation"]
            : [];
      return makeItem(event, {
        primary: related.includes("deferred") ? "deferred" : "resource",
        categories: ["resource", ...related, ...errorCategories],
        label: related.includes("deferred") ? "DEFERRED" : "RESOURCE LOAD",
        summary: words(phase, reason, keys),
        detail: url,
      });
    }
    case "resource-update":
      return makeItem(event, {
        primary: "resource",
        categories: [...categoriesFromSource(data), ...errorCategories],
        label: words("RESOURCE", text(data.key)) || "RESOURCE",
        summary: words(
          data.state === "error" ? "error" : "updated",
          text(data.source, 128)
        ),
        detail: text(data.errorType, 128),
      });
    case "resource-invalidate":
      return makeItem(event, {
        primary: "resource",
        categories: categoriesFromSource(data),
        label: words("RESOURCE", text(data.key)) || "RESOURCE",
        summary: words("invalidated", text(data.source, 128)),
      });
    case "page-cache":
      return makeItem(event, {
        primary: "cache",
        label: "PAGE CACHE",
        summary: words(text(data.action, 64), text(data.source, 128), url),
      });
    case "prefetch":
      return makeItem(event, {
        primary: "cache",
        categories: errorCategories,
        label: "PREFETCH",
        summary: words(phase, url),
      });
    case "mutation":
      return makeItem(event, {
        primary: "mutation",
        categories: errorCategories,
        label: "MUTATION",
        summary: words(text(data.method, 32), url, phase),
        detail: text(data.errorType, 128),
      });
    case "deferred":
      return makeItem(event, {
        primary: "deferred",
        categories: ["resource", ...errorCategories],
        label: "DEFERRED",
        summary: words(phase, keys),
        detail: url,
      });
    case "live":
      return makeItem(event, {
        primary: "live",
        categories: errorCategories,
        label: "LIVE",
        summary: words(phase, text(data.eventType, 64), keys),
        detail: text(data.reason, 128) ?? text(data.errorType, 128),
      });
    case "transport": {
      const requestType = data.requestType === "mutation" ? "mutation" : "navigation";
      const durationMs = number(data.durationMs);
      return makeItem(event, {
        primary: requestType,
        categories: errorCategories,
        label: phase === "start" ? "REQUEST" : "RESPONSE",
        summary: phase === "start"
          ? words(text(data.method, 32), url)
          : words(integer(data.status), url, durationMs === undefined
            ? undefined
            : `${durationMs.toFixed(1)} ms`),
        detail: text(data.errorType, 128),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    }
    case "server-trace": {
      const requestType = data.type === "mutation" ? "mutation" : "navigation";
      const durationMs = number(data.durationMs);
      return makeItem(event, {
        primary: requestType,
        label: "SERVER",
        summary: words(`${requestType} trace`, durationMs === undefined
          ? undefined
          : `${durationMs.toFixed(1)} ms`),
        detail: data.truncated === true ? "trace truncated" : undefined,
        ...(durationMs === undefined ? {} : { durationMs }),
        waterfall: serverWaterfall(data),
      });
    }
    case "lifecycle": {
      const live = phase?.startsWith("live-") ?? false;
      return makeItem(event, {
        primary: live ? "live" : "navigation",
        label: "RUNTIME",
        summary: phase ?? "lifecycle",
      });
    }
  }
}

function resourceTraceItems(
  event: FluxDiagnosticEvent,
  data: Record<string, unknown>
): TimelineItem[] {
  if (data.type !== "page" || !Array.isArray(data.resources)) return [];
  const items: TimelineItem[] = [];
  data.resources.slice(0, MAX_TRACE_RESOURCES).forEach((value, index) => {
    if (!isRecord(value)) return;
    const key = text(value.key);
    const result = text(value.result, 64);
    const durationMs = number(value.durationMs);
    if (!key || !result || durationMs === undefined) return;
    const cacheResult = text(value.cacheResult, 64);
    const categories: TimelineCategory[] = [];
    if (cacheResult === "hit" || cacheResult === "miss") categories.push("cache");
    if (value.deferred === true || result === "deferred") categories.push("deferred");
    if (result === "error") categories.push("error");
    items.push(makeItem(event, {
      id: `${event.id}:resource:${index}`,
      primary: "resource",
      categories,
      label: `RESOURCE ${key}`,
      summary: result,
      detail: words(
        text(value.cacheBackend, 64),
        cacheResult,
        text(value.scope, 64)
      ),
      durationMs,
    }));
  });
  return items;
}

function mutationTraceItems(
  event: FluxDiagnosticEvent,
  data: Record<string, unknown>
): TimelineItem[] {
  if (data.type !== "mutation") return [];
  const items: TimelineItem[] = [];
  if (Array.isArray(data.patches)) {
    data.patches.slice(0, MAX_TRACE_RESOURCES).forEach((value, index) => {
      if (!isRecord(value) || !isRecord(value.operations)) return;
      const key = text(value.key);
      if (!key) return;
      const operations = Object.entries(value.operations)
        .slice(0, 5)
        .flatMap(([operation, count]) => {
          const safeCount = integer(count);
          return safeCount === undefined ? [] : [`${operation} ×${safeCount}`];
        });
      items.push(makeItem(event, {
        id: `${event.id}:patch:${index}`,
        primary: "mutation",
        categories: ["resource"],
        label: `PATCH ${key}`,
        summary: operations.join(", ") || "resource patch",
      }));
    });
  }
  if (Array.isArray(data.invalidated)) {
    data.invalidated.slice(0, MAX_TRACE_RESOURCES).forEach((value, index) => {
      const key = text(value);
      if (!key) return;
      items.push(makeItem(event, {
        id: `${event.id}:invalidate:${index}`,
        primary: "mutation",
        categories: ["resource"],
        label: `INVALIDATE ${key}`,
        summary: "server invalidation",
      }));
    });
  }
  const liveSignals = integer(data.liveSignals);
  if (liveSignals !== undefined && liveSignals > 0) {
    items.push(makeItem(event, {
      id: `${event.id}:live-signals`,
      primary: "live",
      categories: ["mutation"],
      label: "LIVE SIGNAL",
      summary: `${liveSignals} emitted`,
    }));
  }
  return items;
}

function phase(
  label: string,
  durationMs: number | undefined,
  offsetMs: number
): TimelineWaterfallPhase | undefined {
  return durationMs === undefined
    ? undefined
    : Object.freeze({ label, durationMs, offsetMs });
}

function serverWaterfall(
  data: Record<string, unknown>
): readonly TimelineWaterfallPhase[] {
  const phases: Array<TimelineWaterfallPhase | undefined> = [];
  if (data.type === "page") {
    const pageMs = number(data.pageMs);
    const resourcesMs = number(data.resourcesMs);
    phases.push(phase("Page handler", pageMs, 0));
    if (Array.isArray(data.resources)) {
      for (const value of data.resources.slice(0, MAX_TRACE_RESOURCES)) {
        if (!isRecord(value)) continue;
        const key = text(value.key);
        const durationMs = number(value.durationMs);
        if (key) phases.push(phase(key, durationMs, pageMs ?? 0));
      }
    }
    phases.push(phase(
      "Serialize",
      number(data.serializeMs),
      (pageMs ?? 0) + (resourcesMs ?? 0)
    ));
  } else if (data.type === "mutation") {
    const handlerMs = number(data.handlerMs);
    const invalidationMs = number(data.invalidationMs);
    phases.push(phase("Handler", handlerMs, 0));
    phases.push(phase("Invalidation", invalidationMs, handlerMs ?? 0));
    phases.push(phase(
      "Serialize",
      number(data.serializeMs),
      (handlerMs ?? 0) + (invalidationMs ?? 0)
    ));
  }
  return Object.freeze(
    phases.filter((item): item is TimelineWaterfallPhase => item !== undefined)
  );
}

function eventItems(event: FluxDiagnosticEvent): TimelineItem[] {
  const base = baseEventItem(event);
  if (event.type !== "server-trace" || !isRecord(event.data)) return [base];
  return [
    base,
    ...resourceTraceItems(event, event.data),
    ...mutationTraceItems(event, event.data),
  ];
}

/** Expand bounded diagnostic events into a separately bounded display model. */
export function deriveTimeline(
  events: readonly FluxDiagnosticEvent[]
): readonly TimelineItem[] {
  const groups: TimelineItem[][] = [];
  let remaining = MAX_TIMELINE_ITEMS;
  for (let index = events.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const group = eventItems(events[index]);
    groups.unshift(group.slice(0, remaining));
    remaining -= Math.min(group.length, remaining);
  }
  return Object.freeze(groups.flat());
}

export function filterTimeline(
  items: readonly TimelineItem[],
  categories: readonly TimelineCategory[],
  query: string
): readonly TimelineItem[] {
  const selected = new Set(categories);
  const needle = query.trim().toLocaleLowerCase().slice(0, 256);
  return items.filter(item => (
    (selected.size === 0 || item.categories.some(category => selected.has(category))) &&
    (needle.length === 0 || item.searchText.includes(needle))
  ));
}

export function formatTimelineTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}
