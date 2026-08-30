"use client";

import { useDeferredResource } from "@fluxfast/next";

interface Analytics {
  revenue: number;
  load: number;
}

export default function HomePage() {
  const analytics = useDeferredResource<Analytics>("analytics");

  return (
    <main>
      <h1>Clean deferred consumer</h1>
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
