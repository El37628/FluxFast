"use client";

import { Link, useDeferredResource } from "@fluxfast/next";

export default function DeferredCachePage() {
  const analytics = useDeferredResource("cached-analytics");

  return (
    <main>
      <h1>Cached deferred dashboard</h1>
      {analytics.data ? (
        <p data-testid="cached-analytics-value">
          Cached revenue {analytics.data.revenue}
        </p>
      ) : (
        <p data-testid="cached-analytics-loading">Loading cached analytics…</p>
      )}
      <Link href="/rooms" prefetch={false}>Manage rooms</Link>
    </main>
  );
}
