"use client";

import { useDeferredResource, useRouter } from "@fluxfast/next";

interface LiveAnalytics {
  generation: number;
  revenue: number;
}

export default function DeferredMutationPage() {
  const analytics = useDeferredResource<LiveAnalytics>("live-analytics");
  const router = useRouter();

  return (
    <main>
      <h1>Deferred mutation dashboard</h1>
      {analytics.data ? (
        <p data-testid="live-analytics-value">
          Generation {analytics.data.generation}: revenue {analytics.data.revenue}
        </p>
      ) : (
        <p data-testid="live-analytics-loading">Loading live analytics…</p>
      )}
      {analytics.status === "loading" && analytics.data ? (
        <p data-testid="live-analytics-refreshing">Refreshing analytics…</p>
      ) : null}
      {analytics.stale ? (
        <p data-testid="live-analytics-stale">Showing the previous value</p>
      ) : null}
      <button
        type="button"
        disabled={analytics.status !== "ready"}
        onClick={() => void router.mutate("/deferred-mutation/refresh")}
      >
        Refresh analytics
      </button>
    </main>
  );
}
