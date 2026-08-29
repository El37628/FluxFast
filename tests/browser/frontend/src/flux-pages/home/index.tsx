"use client";

import { Link, useResource } from "@fluxfast/next";

interface ApplicationDetails {
  name: string;
}

export default function HomePage() {
  const application = useResource<ApplicationDetails>("application");

  return (
    <main>
      <p data-testid="application-name">{application.name}</p>
      <h1>Control Center</h1>
      <Link href="/rooms" prefetch={false}>
        Manage rooms
      </Link>
    </main>
  );
}
