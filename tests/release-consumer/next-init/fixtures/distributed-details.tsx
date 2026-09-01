"use client";

import { Link, usePage, useResource } from "@fluxfast/next";

interface DistributedSummary {
  mode: "typed-blocking";
  loadedBy: string;
}

function returnUrl(url: string): string {
  const query = new URL(url, "http://fluxfast.local").searchParams;
  return `/?${query}`;
}

export default function DistributedDetailsPage() {
  const page = usePage();
  const summary = useResource<DistributedSummary>("distributed-summary");

  return (
    <main>
      <h1>Compatibility details</h1>
      <p data-testid="distributed-details-summary">
        {summary.mode} loaded by {summary.loadedBy}
      </p>
      <Link href={returnUrl(page.url)} prefetch={false}>
        Back to distributed consumer
      </Link>
    </main>
  );
}
