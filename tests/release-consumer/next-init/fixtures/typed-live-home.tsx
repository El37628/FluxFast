"use client";

import {
  useDeferredResource,
  useLiveStatus,
  useResource,
  useRouter,
} from "@fluxfast/next";
import { mutations } from "@/.fluxfast/mutations.generated";
import { resourceKeys } from "@/.fluxfast/types.generated";

export default function HomePage() {
  const analytics = useDeferredResource(resourceKeys.analytics);
  const counter = useResource(resourceKeys.liveCounter);
  const report = useDeferredResource(resourceKeys.liveReport);
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
      <button
        type="button"
        onClick={() => void mutations.increment(router, { body: { amount: 1 } })}
      >
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
