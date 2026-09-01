"use client";

import { Link, useResource } from "@fluxfast/next";
import { routes } from "@/.fluxfast/routes.generated";

export default function HomePage() {
  const application = useResource("application");

  return (
    <main>
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
