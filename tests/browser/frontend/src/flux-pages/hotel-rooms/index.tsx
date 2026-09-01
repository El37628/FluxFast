"use client";

import { Link, useResource } from "@fluxfast/next";
import { routes } from "@/.fluxfast/routes.generated";

export default function HotelRoomsPage() {
  const hotel = useResource("hotel");
  const rooms = useResource("rooms");

  return (
    <main>
      <h1>{hotel.name} rooms</h1>
      <p data-testid="typed-hotel-id">Hotel ID {hotel.id}</p>
      <ul aria-label="Typed hotel room list">
        {rooms.map(room => <li key={room.id}>{room.name}</li>)}
      </ul>
      <Link href={routes.home()} prefetch={false}>
        Back to control center
      </Link>
    </main>
  );
}
