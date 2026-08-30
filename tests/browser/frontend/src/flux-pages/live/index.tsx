"use client";

import { useMemo } from "react";
import {
  Link,
  useDeferredResource,
  useLiveStatus,
  usePage,
  useResource,
  useResourceState,
  useRouter,
} from "@fluxfast/next";

interface CounterValue {
  value: number;
}

interface LiveIdentity {
  run: string;
  tenant: string;
  user: string;
}

function identityFromUrl(url: string): LiveIdentity {
  const params = new URL(url, "http://fluxfast.local").searchParams;
  return {
    run: params.get("run") ?? "default",
    tenant: params.get("tenant") ?? "tenant-a",
    user: params.get("user") ?? "user-a",
  };
}

export default function LivePage() {
  const page = usePage();
  const router = useRouter();
  const live = useLiveStatus();
  const identity = useMemo(() => identityFromUrl(page.url), [page.url]);
  const counter = useResource<CounterValue>("live-counter");
  const notifications = useResource<CounterValue>("live-notifications");
  const deferred = useDeferredResource<CounterValue>("live-deferred");
  const patched = useResourceState<CounterValue>("live-patched");

  return (
    <main>
      <h1>Live dashboard</h1>
      <p data-testid="live-status">{live.status}</p>
      <p data-testid="live-counter-value">{counter.value}</p>
      <p data-testid="live-notification-value">{notifications.value}</p>

      {deferred.data ? (
        <p data-testid="live-deferred-value">{deferred.data.value}</p>
      ) : (
        <p data-testid="live-deferred-loading">Loading deferred live value…</p>
      )}
      {deferred.stale ? (
        <p data-testid="live-deferred-stale">Deferred value is stale</p>
      ) : null}

      <p data-testid="live-patch-value">{patched.data?.value}</p>
      {patched.stale ? (
        <p data-testid="live-patch-stale">Patched value is being verified</p>
      ) : null}

      <button
        type="button"
        onClick={() => void router.mutate("/live/counter", identity)}
      >
        Increment tenant counter
      </button>
      <button
        type="button"
        onClick={() => void router.mutate("/live/notifications", identity)}
      >
        Add user notification
      </button>
      <button
        type="button"
        onClick={() => void router.mutate("/live/deferred", identity)}
      >
        Update deferred live value
      </button>
      <button
        type="button"
        onClick={() => void router.mutate("/live/patch", identity)}
      >
        Publish live patch
      </button>

      <Link href="/rooms" prefetch={false}>
        Leave live dashboard
      </Link>
    </main>
  );
}
