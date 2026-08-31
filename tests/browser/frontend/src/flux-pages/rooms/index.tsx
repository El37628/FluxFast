"use client";

import { useForm, useResource, useRouter } from "@fluxfast/next";
import { useEffect, useState } from "react";

interface ApplicationDetails {
  name: string;
}

interface Room {
  id: number;
  name: string;
}

export default function RoomsPage() {
  const application = useResource<ApplicationDetails>("application");
  const rooms = useResource<Room[]>("rooms");
  const router = useRouter();
  const form = useForm({ name: "" });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  return (
    <main>
      <p data-testid="application-name">{application.name}</p>
      <h1>Rooms</h1>
      <ul aria-label="Room list">
        {rooms.map(room => <li key={room.id}>{room.name}</li>)}
      </ul>

      <form
        onSubmit={form.submit("/rooms", {
          onSuccess: () => form.reset(),
        })}
      >
        <label htmlFor="room-name">Room name</label>
        <input
          id="room-name"
          name="name"
          value={form.data.name}
          onChange={event => form.setData("name", event.target.value)}
        />
        {form.errors.name ? <p role="alert">{form.errors.name}</p> : null}
        <button type="submit" disabled={form.processing}>Add room</button>
        {form.wasSuccessful ? <p role="status">Room added</p> : null}
      </form>

      <button type="button" onClick={() => void router.mutate("/rooms/finish")}>
        Finish
      </button>
      <button
        type="button"
        disabled={!hydrated}
        onClick={() => void router.mutate("/rooms/missing")}
      >
        Missing redirect
      </button>
    </main>
  );
}
