# FluxFast

FluxFast is a server-driven application runtime for FastAPI. FastAPI owns
routing, validation, authentication, and data loading; frontend adapters render
the interface.

Unlike page-prop synchronization systems, FluxFast synchronizes independently
versioned resources. Shared resources can be reused across pages, cached with
explicit security scopes, resolved concurrently, and selectively invalidated
after mutations. The frontend adapter targets the Next.js 16 App Router.

## Quickstart

Create a Python environment and install the backend package:

```bash
python -m venv .venv
source .venv/bin/activate
pip install fluxfast
```

Create `backend/main.py`:

```python
from fastapi import FastAPI
from fluxfast import FluxFast, Page

app = FastAPI()
flux = FluxFast(app)


@flux.page("/")
async def home():
    return Page(component="home/index")
```

Create and initialize the frontend from the same parent directory:

```bash
npx create-next-app@latest frontend
cd frontend
npm install @fluxfast/next
npx fluxfast init
cd ..
```

`fluxfast init` detects the project layout and language, configures Next.js,
creates the catch-all shell and registry, and safely migrates the standard
Create Next App home page. Replace `frontend/src/flux-pages/home/index.tsx`
(or `frontend/flux-pages/home/index.tsx` in a root-layout project) with:

```tsx
"use client";

export default function HomePage() {
  return <h1>Hello FluxFast</h1>;
}
```

Start FastAPI and Next.js with one public browser origin:

```bash
fluxfast dev backend.main:app --frontend frontend
```

Open `http://127.0.0.1:3000`. FluxFast keeps the FastAPI port private to the
supervisor, so the browser does not need a backend URL and local development
does not require CORS configuration.

Run `npx fluxfast doctor` inside the frontend directory whenever you want to
verify the setup. See the [Next.js adapter guide](docs/nextjs-adapter.md) for
automatic setup options, diagnostics, and troubleshooting. Advanced projects
can use the [manual setup guide](docs/nextjs-manual-setup.md).

## Resources

FastAPI page handlers can resolve independently cached resources:

```python
from fastapi import Depends
from fluxfast import Page, resource, scope


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

The matching client page reads resources by name:

```tsx
"use client";

import { useResource } from "@fluxfast/next";

export default function RoomsPage() {
  const rooms = useResource<Room[]>("rooms");
  return rooms.map(room => <div key={room.id}>{room.number}</div>);
}
```

Secondary resources can load after the page shell:

```python
resource(
    "analytics",
    load_analytics,
    scope=scope.tenant(user.hotel_id),
    ttl=60,
    defer=True,
)
```

```tsx
const analytics = useDeferredResource<Analytics>("analytics");

if (!analytics.data) return <AnalyticsSkeleton />;
return <AnalyticsChart value={analytics.data} />;
```

Deferred cache misses are fetched after hydration without changing the page or
browser history. See the [deferred resources guide](docs/deferred-resources.md)
for loading/error/retry states, caching, SSR, prefetch, mutations, and guidance
on which data must remain blocking.

## Packages

- `python/fluxfast`: FastAPI routes, resource engine, scoped server cache, and
  mutation helpers.
- `packages/core`: framework-neutral browser runtime with no React or Next.js
  imports.
- `packages/next`: Next.js 16 App Router adapter, onboarding CLI, and registry
  generator.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
./.venv/bin/python -m pytest -q python/fluxfast/tests
pnpm benchmark
```

Read [architecture](docs/architecture.md), [protocol](docs/protocol.md),
[caching](docs/caching.md), [deferred resources](docs/deferred-resources.md),
[Next.js integration](docs/nextjs-adapter.md), and [mutations](docs/mutations.md)
before extending a wire or cache boundary. The [compatibility and versioning
policy](docs/versioning.md) lists supported runtimes and the deprecation policy.
Maintainers can find the registry and tag procedure in the [release
guide](docs/releasing.md).

FluxFast is not an Inertia wrapper and does not implement the Inertia protocol.
