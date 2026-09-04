# Mutations and Forms

Register mutations with `FluxRouter.mutation()` or `FluxFast.mutation()`. Return
`mutation(...)` with a small set of patches, scoped invalidations, or redirects.

```python
return mutation(
    patches={
        "rooms": [replace_item(room.id, serialize_room(room))],
    },
    invalidates=[
        invalidate_resource("rooms", scope=scope.tenant(hotel.id)),
        invalidate_resource("summary", scope=scope.tenant(hotel.id)),
    ],
)
```

Server invalidation and client invalidation solve different problems. The scoped
descriptor deletes the authoritative server cache entry; its logical key tells
the browser what became stale. If that key has active subscribers, the last
value remains visible while FluxFast requests only the invalidated active keys.
Inactive keys are removed without a request.

## Generated JSON mutation helpers

FastAPI request models, path parameters, query parameters, the registered route
name, and the declared HTTP method can generate a typed frontend helper:

```python
from pydantic import BaseModel


class RoomInput(BaseModel):
    name: str


@flux.mutation("/hotels/{hotel_id}/rooms", name="add_room")
async def add_room(hotel_id: int, body: RoomInput):
    ...
```

After running `fluxfast types`, call it through the existing router:

```tsx
import { mutations } from "@/.fluxfast/mutations.generated";
import { useRouter } from "@fluxfast/next";

const router = useRouter();

await mutations.addRoom(router, {
  params: { hotel_id: 42 },
  body: { name: "Garden Suite" },
});
```

The helper encodes path and query values, fixes the server-declared method, and
returns the normal `MutationEnvelope`; invalidation, patches, redirects, form
errors, and live propagation therefore keep the behavior described below.

Each mutation body also generates:
1. A reusable TypeScript interface in `@/.fluxfast/types.generated.ts` (e.g.,
   `AddRoomBody`), which can be imported directly into forms, components, and
   state stores.
2. A matching native runtime validator in `@/.fluxfast/validators.generated.ts`
   (e.g., `AddRoomBodyValidator`), powered by `@fluxfast/core` with zero third-party
   dependencies.

Only mutations with JSON body schemas generate helpers and reusable body types.
Multipart uploads, streams, and non-JSON endpoints continue to use application-owned
clients. See [typed resource contracts and code generation](type-safety.md) and
[General Application Contracts](contracts.md) for naming, generation, and drift
checks.

## Live propagation to other clients

When an invalidation descriptor has an explicit reusable scope, FluxFast also
publishes it through the configured live broker:

```text
Browser A mutation
      ↓
FastAPI updates authoritative data
      ↓
scoped server cache entry is deleted
      ↓
live invalidation is published
      ↓
Browser B in the same scope marks its value stale
      ↓
Browser B performs one canonical resource-only refresh
```

This is automatic for `invalidate_resource(...)`; no separate realtime endpoint
or frontend handler is needed. A string-only invalidation has no server scope,
so it updates the mutation response for the originating browser but cannot
delete a scoped cache entry or broadcast safely:

```python
# Local response hint only:
mutation(invalidate=["summary"])

# Server cache invalidation plus scoped live broadcast:
mutation(
    invalidates=[
        invalidate_resource("summary", scope=scope.tenant(hotel.id))
    ]
)
```

The router sends one opaque per-tab `X-FluxFast-Client-ID` with the mutation.
The server echoes it only as `originClientId` on the live signal. The matching
tab ignores that echo because its mutation envelope already handles the
invalidation; other tabs remain eligible and refresh. Client IDs are not user
or tenant identities and are never used for authorization.

Publication failure is isolated from the business transaction. Cache deletion
happens first; a broker error is logged and the successful mutation response is
still returned. Reconnect and later canonical refresh recover current state.
With multiple FastAPI workers, configure `RedisLiveBroker`; also follow the
[multi-worker resource-cache rules](caching.md#multiple-workers) so a canonical
refresh cannot read an old process-local positive-TTL entry.

For positive-TTL live resources across workers, pair the broker with
`RedisResourceCache`. Its cache failure semantics are intentionally stricter
than broker publication: if the shared delete fails, FluxFast raises a cache
error and does not publish a signal that could send other clients into stale
cache entries. There is no implicit local-memory fallback. See [distributed
resource coherence](distributed-cache.md#failure-semantics).

## Deferred resource invalidation

The same invalidation contract applies at every deferred lifecycle state:

- A **ready, subscribed** value is marked stale/loading. The previous data stays
  visible, its version is excluded from `X-FluxFast-Known`, and a
  mutation-labeled resource-only request replaces it with the canonical value.
- A **pending or loading, subscribed** key keeps its pending/loading UI while a
  newer request starts. The mutation advances that key's generation, so an
  older deferred response cannot overwrite post-mutation state.
- A **failed, subscribed** key returns to loading for revalidation. If the new
  loader also fails, the page remains mounted and the key receives a new
  isolated error.
- An **inactive** key is removed without an eager request. A future page visit
  can declare it again; a consumer mounted before then can call `retry()` to
  request it explicitly.

The revalidation response updates `ResourceStore` only; it does not reload the
page, replace `PageStore`, push history, or change scroll. The FastAPI page and
dependencies still run to verify that each `X-FluxFast-Only` key belongs to the
current authorized resource graph.

Patches also advance resource generations, preventing an older in-flight load
from replacing an optimistic value. A browser patch cannot assign an
authoritative server version, so the patched record remains stale. Pair the
patch with a scoped invalidation when active consumers should immediately load
the canonical representation.

Manual server code may publish the same semantics with
`await flux.live.invalidate(...)` or `await flux.live.patch(...)`. Both require
an explicit reusable scope and delete its cache entry before publication. Live
patches reuse the five mutation patch operations, render immediately when
valid, and always revalidate canonical loader state afterward.

Internal or external redirects take precedence over resource-only mutation
revalidation. The destination visit is responsible for applying its own page
resource graph.

`useForm(initialData, options?)` manages form state, validation, and submissions:

- **Options:** Pass `{ validator: MyValidator }` using a generated native validator
  from `@/.fluxfast/validators.generated`.
- **State:** Exposes `data`, `errors` (top-level string map), `issues` (structured
  `readonly ValidationIssue[]`), `errorMap` (path-string to message map),
  `processing`, `wasSuccessful`, and `recentlySuccessful`.
- **Actions:** `setData(key, value)`, `setData(updates)`, `setError(key, msg)`,
  `clearErrors(...keys)`, `reset(...keys)`, and `validate()`.
- **Pre-submit validation:** `form.submit(url, options)` automatically validates
  the form before dispatching a mutation. If validation fails, no network request
  is sent, and `errors`, `issues`, and `errorMap` update immediately.
- **Server validation:** Standard FastAPI 422 detail arrays and FluxFast error
  envelopes map seamlessly into `form.errors` and `form.errorMap`. Non-validation
  failures are not swallowed.

See [Native Client Validation](validation.md) for full form validation examples and
refinement patterns.

Internal redirects use `router.visit`. External redirects use a full browser
navigation. Applications are responsible for authentication, authorization,
CSRF protection, and validating mutation payloads through FastAPI.
