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

When the backend declares typed resources, routes, or JSON mutations, export
their schema and generate the matching frontend contracts with one command:

```bash
fluxfast types backend.main:app --frontend frontend
```

The command uses the frontend's installed `@fluxfast/next` CLI, detects its
layout, and updates the manifest, resource types, route builders, mutation
helpers, and page registry together. Use the read-only form in CI:

```bash
fluxfast types backend.main:app --frontend frontend --check
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

## Production

Build the checked frontend artifact, then run both runtimes as one supervised
service:

```bash
fluxfast build --app backend.main:app --frontend frontend

fluxfast start backend.main:app \
  --frontend frontend
```

FluxFast starts FastAPI privately and exposes the Next.js application as the
single public service. The browser stays on that origin and does not need a
backend port or CORS configuration. See the [production deployment
guide](docs/production.md) for workers, health checks, shutdown, process
managers, proxies, and troubleshooting, or [container
deployment](docs/containers.md) for Docker, rootless Podman, and Compose.

## Resources

FastAPI page handlers can resolve independently cached resources:

```python
from fastapi import Depends
from fluxfast import Page, resource, scope
from pydantic import BaseModel


class Room(BaseModel):
    id: int
    number: str


ROOMS = flux.define_resource("rooms", list[Room])


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
                ROOMS,
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
import { resourceKeys } from "@/.fluxfast/types.generated";

export default function RoomsPage() {
  const rooms = useResource(resourceKeys.rooms);
  return rooms.map(room => <div key={room.id}>{room.number}</div>);
}
```

The Pydantic contract validates the loader's serialized wire value and
generates the `Room[]` hook type. String-key resources and explicit frontend
generics remain supported for incremental migration. See [typed resource
contracts and code generation](docs/type-safety.md) for serialization rules,
generated routes and mutations, and CI drift checks.

Secondary resources can load after the page shell:

```python
ANALYTICS = flux.define_resource("analytics", Analytics)

resource(
    ANALYTICS,
    load_analytics,
    scope=scope.tenant(user.hotel_id),
    ttl=60,
    defer=True,
)
```

```tsx
const analytics = useDeferredResource(resourceKeys.analytics);

if (!analytics.data) return <AnalyticsSkeleton />;
return <AnalyticsChart value={analytics.data} />;
```

Deferred cache misses are fetched after hydration without changing the page or
browser history. See the [deferred resources guide](docs/deferred-resources.md)
for loading/error/retry states, caching, SSR, prefetch, mutations, and guidance
on which data must remain blocking.

A resource can remain synchronized after hydration:

```python
NOTIFICATIONS = flux.define_resource("notifications", list[Notification])

resource(
    NOTIFICATIONS,
    load_notifications,
    scope=scope.user(user.id),
    live=True,
)
```

When another request invalidates this scoped resource, connected clients
automatically refresh it from the canonical loader. The frontend continues to
use the ordinary `useResource("notifications")` hook. See [Live
Resources](docs/live-resources.md) for mutations, patches, reconnect, Redis,
security, and deployment requirements.

## Multiple workers

The default resource cache is process-local. To share positive-TTL resources
across FastAPI workers or hosts, install the Redis extra and configure an
explicit application namespace:

```bash
pip install "fluxfast[redis]"
```

```python
import os

from fluxfast import RedisLiveBroker, RedisResourceCache

redis_url = os.environ["REDIS_URL"]
namespace = "hotel-prod"
cache = RedisResourceCache.from_url(redis_url, namespace=namespace)
broker = RedisLiveBroker.from_url(
    redis_url,
    channel_prefix=f"fluxfast:{namespace}:live:",
)
flux = FluxFast(app, cache=cache, broker=broker)
```

`RedisResourceCache` shares scoped values, native TTL, deletion, and tag
invalidation. `RedisLiveBroker` independently carries ephemeral live signals;
configure both for positive-TTL `live=True` resources across workers. FluxFast
supports Redis Open Source 6.2 through 8.10 and tests both ends of that range.
See [distributed resource coherence](docs/distributed-cache.md) for namespace,
failure, serialization, metrics, lifecycle, security, and background-publisher
guidance.

## Packages

- `python/fluxfast`: FastAPI routes, resource engine, process-local and Redis
  scoped server caches, live coordination, and mutation helpers.
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
# Requires Redis at redis://127.0.0.1:6379/15 by default.
pnpm benchmark
```

Read [architecture](docs/architecture.md), [protocol](docs/protocol.md),
[caching](docs/caching.md), [distributed resource
coherence](docs/distributed-cache.md), [deferred
resources](docs/deferred-resources.md), [Live Resources](docs/live-resources.md),
[typed resource contracts](docs/type-safety.md), [Next.js
integration](docs/nextjs-adapter.md), [production deployment](docs/production.md),
[containers](docs/containers.md), and [mutations](docs/mutations.md) before
extending a wire, schema, cache, or deployment boundary. The [compatibility and
versioning policy](docs/versioning.md) lists supported runtimes and the
deprecation policy. Maintainers can find the registry and tag procedure in the
[release guide](docs/releasing.md).

FluxFast is not an Inertia wrapper and does not implement the Inertia protocol.
