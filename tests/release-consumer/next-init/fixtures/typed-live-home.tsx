"use client";

import {
  useForm,
  useDeferredResource,
  useLiveStatus,
  useResource,
  useRouter,
} from "@fluxfast/next";
import { mutations } from "@/.fluxfast/mutations.generated";
import {
  resourceKeys,
  type RegistrationInput,
} from "@/.fluxfast/types.generated";
import { RegistrationInputValidator } from "@/.fluxfast/validators.generated";
import { UserCard } from "@/components/UserCard";
import { featuredUser } from "@/lib/users";

export default function HomePage() {
  const analytics = useDeferredResource(resourceKeys.analytics);
  const counter = useResource(resourceKeys.liveCounter);
  const report = useDeferredResource(resourceKeys.liveReport);
  const live = useLiveStatus();
  const router = useRouter();
  const registration = useForm<RegistrationInput>(
    {
      name: "",
      email: "",
      address: { city: "", postcode: "" },
    },
    { validator: RegistrationInputValidator },
  );

  return (
    <main>
      <h1>Clean live consumer</h1>
      <UserCard user={featuredUser} />
      <p data-testid="live-status">{live.status}</p>
      <p data-testid="live-counter-value">{counter.value}</p>
      {report.data ? (
        <p data-testid="live-report-value">{report.data.value}</p>
      ) : (
        <p data-testid="live-report-loading">Loading live report…</p>
      )}
      {report.stale ? (
        <p data-testid="live-report-stale">Live report is stale</p>
      ) : null}
      <button
        type="button"
        onClick={() => void mutations.increment(router, { body: { amount: 1 } })}
      >
        Increment live resources
      </button>
      <form
        aria-label="Registration"
        onSubmit={registration.submit("/registrations", {
          onSuccess: () => registration.reset(),
        })}
      >
        <label htmlFor="registration-name">Registration name</label>
        <input
          id="registration-name"
          value={registration.data.name}
          onChange={event => registration.setData("name", event.target.value)}
        />
        {registration.errors.name ? <p role="alert">{registration.errors.name}</p> : null}

        <label htmlFor="registration-email">Registration email</label>
        <input
          id="registration-email"
          value={registration.data.email}
          onChange={event => registration.setData("email", event.target.value)}
        />
        {registration.errors.email ? <p role="alert">{registration.errors.email}</p> : null}

        <label htmlFor="registration-city">Registration city</label>
        <input
          id="registration-city"
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
          value={registration.data.address.postcode}
          onChange={event => registration.setData({
            address: { ...registration.data.address, postcode: event.target.value },
          })}
        />
        {registration.errorMap["address.postcode"] ? (
          <p role="alert">{registration.errorMap["address.postcode"]}</p>
        ) : null}

        <button type="submit" disabled={registration.processing}>Register</button>
        {registration.wasSuccessful ? (
          <p role="status">Registration accepted</p>
        ) : null}
      </form>
      {analytics.data ? (
        <p data-testid="analytics-value">
          Revenue {analytics.data.revenue} from loader {analytics.data.load}
        </p>
      ) : (
        <p data-testid="analytics-loading">Loading analytics…</p>
      )}
    </main>
  );
}
