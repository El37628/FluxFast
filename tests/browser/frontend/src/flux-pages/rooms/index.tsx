"use client";

import { useForm, useResource, useRouter } from "@fluxfast/next";
import { RegistrationInputValidator } from "@/.fluxfast/validators.generated";
import type { RegistrationInput } from "@/.fluxfast/types.generated";
import { UserCard } from "@/components/UserCard";
import { featuredUser } from "@/lib/users";
import { useEffect, useState } from "react";

export default function RoomsPage() {
  const application = useResource("application");
  const rooms = useResource("rooms");
  const router = useRouter();
  const form = useForm({ name: "" });
  const registration = useForm<RegistrationInput>(
    {
      name: "",
      email: "",
      address: { city: "", postcode: "" },
    },
    { validator: RegistrationInputValidator },
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  return (
    <main>
      <p data-testid="application-name">{application.name}</p>
      <h1>Rooms</h1>
      <ul aria-label="Room list">
        {rooms.map(room => <li key={room.id}>{room.name}</li>)}
      </ul>
      <UserCard user={featuredUser} />

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

      <form
        aria-label="Registration"
        onSubmit={registration.submit("/registrations", {
          onSuccess: () => registration.reset(),
        })}
      >
        <label htmlFor="registration-name">Registration name</label>
        <input
          id="registration-name"
          name="name"
          value={registration.data.name}
          onChange={event => registration.setData("name", event.target.value)}
        />
        {registration.errors.name ? (
          <p role="alert">{registration.errors.name}</p>
        ) : null}

        <label htmlFor="registration-email">Registration email</label>
        <input
          id="registration-email"
          name="email"
          value={registration.data.email}
          onChange={event => registration.setData("email", event.target.value)}
        />
        {registration.errors.email ? (
          <p role="alert">{registration.errors.email}</p>
        ) : null}

        <label htmlFor="registration-city">Registration city</label>
        <input
          id="registration-city"
          name="city"
          value={registration.data.address.city}
          onChange={event => registration.setData({
            address: { ...registration.data.address, city: event.target.value },
          })}
        />
        {registration.errorMap["address.city"] ? (
          <p role="alert">{registration.errorMap["address.city"]}</p>
        ) : null}

        <label htmlFor="registration-postcode">Registration postcode</label>
        <input
          id="registration-postcode"
          name="postcode"
          value={registration.data.address.postcode}
          onChange={event => registration.setData({
            address: { ...registration.data.address, postcode: event.target.value },
          })}
        />
        {registration.errorMap["address.postcode"] ? (
          <p role="alert">{registration.errorMap["address.postcode"]}</p>
        ) : null}

        <button type="submit" disabled={registration.processing}>
          Register
        </button>
        {registration.wasSuccessful ? (
          <p role="status">Registration accepted</p>
        ) : null}
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
