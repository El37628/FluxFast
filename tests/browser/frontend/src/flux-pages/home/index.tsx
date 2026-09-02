"use client";

import { Link, useResource } from "@fluxfast/next";
import { routes } from "@/.fluxfast/routes.generated";
import { useEffect, useState } from "react";

export default function HomePage() {
  const application = useResource("application");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  return (
    <main
      data-testid="home-page"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <p data-testid="application-name">{application.name}</p>
      <h1>Control Center</h1>
      <Link href="/rooms" prefetch={false}>
        Manage rooms
      </Link>
      <Link href={routes.hotelRooms({ hotel_id: 101 })}>
        View Hotel 101 rooms
      </Link>
    </main>
  );
}
