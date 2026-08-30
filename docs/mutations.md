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

Internal or external redirects take precedence over resource-only mutation
revalidation. The destination visit is responsible for applying its own page
resource graph.

`useForm(initialData)` exposes `data`, `errors`, `processing`, success flags,
`setData`, `reset`, `clearErrors`, and `submit`. FluxFast error envelopes and
standard FastAPI 422 detail arrays map normal field names into `form.errors`.
Non-validation failures are not swallowed.

Internal redirects use `router.visit`. External redirects use a full browser
navigation. Applications are responsible for authentication, authorization,
CSRF protection, and validating mutation payloads through FastAPI.
