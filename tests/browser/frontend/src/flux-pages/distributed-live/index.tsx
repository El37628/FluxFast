"use client";

import { useMemo } from "react";
import { useLiveStatus, usePage, useResource, useRouter } from "@fluxfast/next";

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

export default function DistributedLivePage() {
  const page = usePage();
  const router = useRouter();
  const live = useLiveStatus();
  const identity = useMemo(() => identityFromUrl(page.url), [page.url]);
  const counter = useResource("distributed-counter");

  async function incrementOnAvailableWorker(): Promise<void> {
    await router.mutate("/distributed-live/increment", identity);
  }

  return (
    <main>
      <h1>Distributed live dashboard</h1>
      <p data-testid="distributed-live-status">{live.status}</p>
      <p data-testid="distributed-counter-value">{counter.value}</p>
      <p data-testid="distributed-page-worker">{String(page.meta.worker ?? "")}</p>
      <button
        type="button"
        onClick={() => void incrementOnAvailableWorker()}
      >
        Increment distributed counter
      </button>
    </main>
  );
}
