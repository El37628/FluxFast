"use client";

import { usePage } from "@fluxfast/next";

export default function ContractCachePage() {
  const page = usePage();
  return <main><h1 data-testid="contract-cache-url">{page.url}</h1></main>;
}
