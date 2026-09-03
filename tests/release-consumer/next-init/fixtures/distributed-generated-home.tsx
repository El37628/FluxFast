"use client";

import { useMemo } from "react";
import {
  Link,
  useDeferredResource,
  useLiveStatus,
  usePage,
  useResource,
  useRouter,
} from "@fluxfast/next";
import { mutations } from "@/.fluxfast/mutations.generated";
import {
  resourceKeys,
  type DistributedCounter,
  type DistributedCounterResource,
  type DistributedSummary,
  type DistributedSummaryResource,
  type GeneratedFluxResourceMap,
} from "@/.fluxfast/types.generated";

interface DistributedIdentity {
  run: string;
  client: string;
}

function identityFromUrl(url: string): DistributedIdentity {
  const params = new URL(url, "http://fluxfast.local").searchParams;
  return {
    run: params.get("run") ?? "default",
    client: params.get("client") ?? "a",
  };
}

function verifySchemaOneImports(
  counter: DistributedCounterResource,
  summary: DistributedSummaryResource
): GeneratedFluxResourceMap {
  const counterContract: DistributedCounter = counter;
  const summaryContract: DistributedSummary = summary;
  return {
    "distributed-counter": counterContract,
    "distributed-summary": summaryContract,
  };
}

export default function HomePage() {
  const page = usePage();
  const router = useRouter();
  const live = useLiveStatus();
  const identity = useMemo(() => identityFromUrl(page.url), [page.url]);
  const summary = useResource(resourceKeys.distributedSummary);
  const counter = useDeferredResource(resourceKeys.distributedCounter);

  if (counter.data) verifySchemaOneImports(counter.data, summary);

  return (
    <main>
      <h1>Clean distributed consumer</h1>
      <p data-testid="distributed-summary-value">
        {summary.mode} loaded by {summary.loadedBy}
      </p>
      <p data-testid="distributed-live-status">{live.status}</p>
      {counter.data ? (
        <p data-testid="distributed-counter-value">
          {counter.data.value} loaded by {counter.data.loadedBy}
        </p>
      ) : (
        <p data-testid="distributed-counter-loading">Loading counter…</p>
      )}
      <button
        type="button"
        onClick={() => void mutations.increment(router, { body: identity })}
      >
        Increment distributed counter
      </button>
      <Link
        href={`/details?${new URLSearchParams({
          run: identity.run,
          client: identity.client,
        })}`}
        prefetch={false}
      >
        View compatibility details
      </Link>
    </main>
  );
}
