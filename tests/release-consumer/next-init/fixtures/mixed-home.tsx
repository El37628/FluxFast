"use client";

import { useResource } from "@fluxfast/next";

interface Analytics {
  revenue: number;
  load: number;
}

export default function HomePage() {
  const analytics = useResource<Analytics>("analytics");

  return (
    <main>
      <h1>Published mixed consumer</h1>
      <p data-testid="analytics-value">
        Revenue {analytics.revenue} from loader {analytics.load}
      </p>
    </main>
  );
}
