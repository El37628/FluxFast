"use client";

import { Link, usePage, useResource, useResourceState, useRouter } from "@fluxfast/next";
import { useEffect, useState } from "react";

export default function ContractPage() {
  const page = usePage();
  const router = useRouter();
  const context = useResource("contract-context");
  const counter = useResourceState("contract-counter");
  const items = useResource("contract-items");
  const shared = useResource("contract-shared");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const query = new URL(page.url, "http://fixture.local").search;
  return (
    <main data-testid="contract-page" data-hydrated={hydrated ? "true" : "false"}>
      <h1>Contract page {context.number}</h1>
      <pre data-testid="contract-context">{JSON.stringify(context)}</pre>
      <p data-testid="contract-counter">{JSON.stringify(counter.data)}</p>
      <p data-testid="contract-counter-status">{counter.status}</p>
      <p data-testid="contract-counter-stale">{String(counter.stale)}</p>
      {counter.error ? <p role="alert">{counter.error.message}</p> : null}
      <p data-testid="contract-shared">{shared.label}</p>
      <ul aria-label="Contract items">{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
      <button type="button" onClick={() => void router.refresh({ only: ["contract-counter"] }).catch(() => undefined)}>Refresh counter</button>
      <button type="button" onClick={() => void router.loadResources(["contract-counter"], { reason: "retry" }).catch(() => undefined)}>Retry counter</button>
      <Link href={`/contract/${context.number + 1}${query}`} prefetch={false}>Next contract page</Link>
      <div aria-hidden="true" style={{ height: 2_000 }} />
    </main>
  );
}
