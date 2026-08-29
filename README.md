# FluxFast

FluxFast is a server-driven application runtime for FastAPI. FastAPI owns
routing, validation, authentication, and data loading; frontend adapters render
the interface.

Unlike page-prop synchronization systems, FluxFast synchronizes independently
versioned resources. Shared resources can be reused across pages, cached with
explicit security scopes, resolved concurrently, and selectively invalidated
after mutations. The MVP frontend adapter targets the Next.js 16 App Router.

```python
from fastapi import Depends, FastAPI
from fluxfast import FluxFast, Page, resource, scope

app = FastAPI()
flux = FluxFast(app)

@flux.page("/rooms")
async def rooms(user=Depends(current_user)):
    return Page(
        component="rooms/index",
        resources=[
            resource(
                "auth",
                lambda: serialize_user(user),
                scope=scope.user(user.id),
                ttl=300,
            ),
            resource(
                "rooms",
                load_rooms,
                scope=scope.tenant(user.hotel_id),
                ttl=10,
            ),
        ],
    )
```

```tsx
"use client";

import { useResource } from "@fluxfast/next";

export default function RoomsPage() {
  const rooms = useResource<Room[]>("rooms");
  return rooms.map(room => <div key={room.id}>{room.number}</div>);
}
```

## Packages

- `python/fluxfast`: FastAPI routes, resource engine, scoped server cache, and
  mutation helpers.
- `packages/core`: framework-neutral browser runtime with no React or Next.js
  imports.
- `packages/next`: Next.js 16 App Router adapter and registry generator.
- `../fluxfast-example`: independently installable companion example with
  FastAPI, Next.js, and Playwright tests. It intentionally lives outside this
  repository.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
./.venv/bin/python -m pytest -q python/fluxfast/tests
pnpm benchmark
```

For the full application and browser suite, see the
[standalone example](../fluxfast-example/README.md).

The standalone application runs through one same-origin development command:

```bash
cd ../fluxfast-example
.venv/bin/fluxfast dev backend.app.main:app
```

Read [architecture](docs/architecture.md), [protocol](docs/protocol.md),
[caching](docs/caching.md), [Next.js integration](docs/nextjs-adapter.md), and
[mutations](docs/mutations.md) before extending a wire or cache boundary.

FluxFast is not an Inertia wrapper and does not implement the Inertia protocol.
