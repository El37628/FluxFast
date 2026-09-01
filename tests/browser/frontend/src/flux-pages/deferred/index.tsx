"use client";

import { Link, useDeferredResource } from "@fluxfast/next";

export default function DeferredPage() {
  const analytics = useDeferredResource("analytics");
  const activity = useDeferredResource("activity");

  return (
    <main>
      <h1>Deferred dashboard</h1>
      <p>The page shell is available before its slow resources finish.</p>

      <section aria-labelledby="analytics-heading">
        <h2 id="analytics-heading">Analytics</h2>
        {analytics.data ? (
          <p data-testid="analytics-value">
            Revenue {analytics.data.revenue} for the {analytics.data.period}
          </p>
        ) : (
          <p data-testid="analytics-loading">Loading analytics…</p>
        )}
      </section>

      <section aria-labelledby="activity-heading">
        <h2 id="activity-heading">Activity</h2>
        {activity.data ? (
          <ul aria-label="Activity feed">
            {activity.data.map(item => <li key={item.id}>{item.message}</li>)}
          </ul>
        ) : activity.error ? (
          <div role="alert" data-testid="activity-error">
            <p>{activity.error.message}</p>
            <button type="button" onClick={() => void activity.retry()}>
              Retry activity
            </button>
          </div>
        ) : (
          <p data-testid="activity-loading">Loading activity…</p>
        )}
      </section>

      <Link href="/" prefetch={false}>Back to control center</Link>
    </main>
  );
}
