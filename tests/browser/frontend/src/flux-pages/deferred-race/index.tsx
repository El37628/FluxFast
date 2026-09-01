"use client";

import { Link, useDeferredResource } from "@fluxfast/next";

export default function DeferredRacePage() {
  const analytics = useDeferredResource("race-analytics");

  return (
    <main>
      <h1>Deferred navigation race</h1>
      {analytics.data ? (
        <p data-testid="race-analytics-value">
          Race revenue {analytics.data.revenue}
        </p>
      ) : (
        <p data-testid="race-analytics-loading">Loading race analytics…</p>
      )}
      <Link href="/rooms" prefetch={false}>Leave for rooms</Link>
    </main>
  );
}
