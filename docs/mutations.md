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

`useForm(initialData)` exposes `data`, `errors`, `processing`, success flags,
`setData`, `reset`, `clearErrors`, and `submit`. FluxFast error envelopes and
standard FastAPI 422 detail arrays map normal field names into `form.errors`.
Non-validation failures are not swallowed.

Internal redirects use `router.visit`. External redirects use a full browser
navigation. Applications are responsible for authentication, authorization,
CSRF protection, and validating mutation payloads through FastAPI.
