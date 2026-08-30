"use client";

import {
  useDeferredResource,
  useLiveStatus,
  useResource,
  useRouter,
} from "@fluxfast/next";

interface Analytics {
  revenue: number;
  load: number;
}

interface Counter {
  value: number;
}

export default function HomePage() {
  const analytics = useDeferredResource<Analytics>("analytics");
  const counter = useResource<Counter>("live-counter");
  const report = useDeferredResource<Counter>("live-report");
  const live = useLiveStatus();
  const router = useRouter();

  return (
    <main>
      <h1>Clean live consumer</h1>
      <p data-testid="live-status">{live.status}</p>
      <p data-testid="live-counter-value">{counter.value}</p>
      {report.data ? (
        <p data-testid="live-report-value">{report.data.value}</p>
      ) : (
        <p data-testid="live-report-loading">Loading live report…</p>
      )}
      {report.stale ? (
        <p data-testid="live-report-stale">Live report is stale</p>
      ) : null}
      <button type="button" onClick={() => void router.mutate("/increment")}>
        Increment live resources
      </button>
      {analytics.data ? (
        <p data-testid="analytics-value">
          Revenue {analytics.data.revenue} from loader {analytics.data.load}
        </p>
      ) : (
        <p data-testid="analytics-loading">Loading analytics…</p>
      )}
    </main>
  );
}
