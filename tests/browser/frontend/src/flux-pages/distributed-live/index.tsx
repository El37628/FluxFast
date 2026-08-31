"use client";

import { useMemo } from "react";
import { useLiveStatus, usePage, useResource, useRouter } from "@fluxfast/next";

interface CounterValue {
  value: number;
}

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
  const counter = useResource<CounterValue>("distributed-counter");

  return (
    <main>
      <h1>Distributed live dashboard</h1>
      <p data-testid="distributed-live-status">{live.status}</p>
      <p data-testid="distributed-counter-value">{counter.value}</p>
      <button
        type="button"
        onClick={() =>
          void router.mutate("/distributed-live/increment", identity)
        }
      >
        Increment distributed counter
      </button>
    </main>
  );
}
