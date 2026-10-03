# FluxFast

FluxFast is a server-driven application runtime for FastAPI with reactive
resource synchronization. FastAPI owns routing, validation, authentication,
authorization, and data loading; frontend adapters render the interface.

Read the [FluxFast documentation](https://el37628.github.io/FluxFast-Docs/) for
step-by-step tutorials, detailed API explanations, runnable examples, and
deployment guides.

Inertia synchronizes pages and props. FluxFast treats application data as
independently versioned, cached, progressively loaded, and live resources.
Shared resources can be reused across pages, cached with explicit security
scopes, resolved concurrently, and selectively invalidated after mutations.
Frontend hosts support the Next.js 16 App Router and, from FluxFast 1.2,
server-rendered React with Vite. Both use the same resource runtime and React
bindings; FastAPI still owns the application routes.

## Quickstart

Choose the [Next.js walkthrough](https://el37628.github.io/FluxFast-Docs/getting-started/) or the
[React/Vite walkthrough](https://el37628.github.io/FluxFast-Docs/react-getting-started/). Both start from an empty
directory and cover typed resources, expected output, production build and
one-origin startup. The Next example also demonstrates generated validation and
mutations. See the [1.2 release notes](https://el37628.github.io/FluxFast-Docs/releases/v1-2-0/) for package
availability, matching installation versions and existing-application upgrades.
The short example below uses Next.js.

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

When the backend declares typed resources, general contracts, routes, or JSON
mutations, export their schema and generate the matching frontend contracts and
validators with one command:

```bash
fluxfast types backend.main:app --frontend frontend
```

The command uses installed Codegen (or the selected host's local generator),
detects its layout, and updates the manifest, resource types, general application types,
native runtime validators, route builders, mutation helpers, and page registry
together. React/Vite selection follows the declared `@fluxfast/vite` host, or an
explicit `--adapter react`; existing Next projects keep their defaults.
Their filenames, public symbols, naming rules, and per-file
replacement guarantees are documented in the [generated artifact
contract](https://el37628.github.io/FluxFast-Docs/generated-artifacts/). Use the read-only form in CI:

```bash
fluxfast types backend.main:app --frontend frontend --check
```

## General Contracts & Native Validation

FluxFast supports server-owned contracts reusable throughout frontend
components, forms, utilities, and state stores, backed by a dependency-free
native validation engine:

```python
from pydantic import BaseModel, EmailStr
from fluxfast import FluxFast

class RegistrationInput(BaseModel):
    name: str
    email: EmailStr

flux.define_type("RegistrationInput", RegistrationInput, mode="validation")
```

After running `fluxfast types`, consume both the generated TypeScript interface
and the native runtime validator in your frontend without installing Zod or any
other validation package:

```tsx
"use client";

import type { RegistrationInput } from "@/.fluxfast/types.generated";
import { RegistrationInputValidator } from "@/.fluxfast/validators.generated";
import { useForm } from "@fluxfast/next";

export function RegisterPage() {
  const form = useForm<RegistrationInput>(
    { name: "", email: "" },
    { validator: RegistrationInputValidator }
  );

  return (
    <form onSubmit={form.submit("/api/register")}>
      <input
        value={form.data.name}
        onChange={e => form.setData("name", e.target.value)}
      />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input
        value={form.data.email}
        onChange={e => form.setData("email", e.target.value)}
      />
      {form.errors.email && <span>{form.errors.email}</span>}

      <button type="submit" disabled={form.processing}>Register</button>
    </form>
  );
}
```

Pre-submit validation runs synchronously, preventing invalid submissions before
any network request is dispatched. See [General Application
Contracts](https://el37628.github.io/FluxFast-Docs/contracts/) and [Native Client Validation](https://el37628.github.io/FluxFast-Docs/validation/).

Generated TypeScript contracts and generated runtime validators are separate
capabilities. A contract can still produce its TypeScript type when a
validation-affecting JSON Schema keyword is unsupported; FluxFast omits only
that contract's native validator and reports a diagnostic instead of silently
weakening it.

Native client validation improves UX and reduces avoidable requests. FastAPI
and Pydantic remain authoritative for every submitted mutation. Authoritative
nested failures use the same canonical paths as client issues, including
`address.postcode` and `addresses[0].postcode`, and are available through
`form.errorMap`.

Start FastAPI and Next.js with one public browser origin:

```bash
fluxfast dev backend.main:app --frontend frontend
```

Open `http://127.0.0.1:3000`. FluxFast keeps the FastAPI port private to the
supervisor, so the browser does not need a backend URL and local development
does not require CORS configuration.

Run `npx fluxfast doctor` inside the frontend directory whenever you want to
verify the setup. See the [Next.js adapter guide](https://el37628.github.io/FluxFast-Docs/nextjs-adapter/) for
automatic setup options, diagnostics, and troubleshooting. Advanced projects
can use the [manual setup guide](https://el37628.github.io/FluxFast-Docs/nextjs-manual-setup/).

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
guide](https://el37628.github.io/FluxFast-Docs/production/) for workers, health checks, shutdown, process
managers, proxies, and troubleshooting, or [container
deployment](https://el37628.github.io/FluxFast-Docs/containers/) for Docker, rootless Podman, and Compose.

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
contracts and code generation](https://el37628.github.io/FluxFast-Docs/type-safety/) for serialization rules,
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
browser history. See the [deferred resources guide](https://el37628.github.io/FluxFast-Docs/deferred-resources/)
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
Resources](https://el37628.github.io/FluxFast-Docs/live-resources/) for mutations, patches, reconnect, Redis,
security, and deployment requirements.

## DevTools

Install the optional FluxFast DevTools to inspect resource loading, cache hits,
deferred resources, mutations, live synchronization, protocol metadata, and a
correlated runtime timeline during development:

```bash
npm install --save-dev @fluxfast/devtools
```

```tsx
import { FluxDevtools } from "@fluxfast/devtools";

{process.env.NODE_ENV === "development" && <FluxDevtools />}
```

Mount it inside the FluxFast provider and enable `FluxFast(app, debug=True)`
only in the development backend to receive safe server timings. Production
builds resolve an inert package entry and emit no diagnostic request or trace.
See the [DevTools guide](https://el37628.github.io/FluxFast-Docs/devtools/) for every panel, security exclusions,
SSR behavior, performance bounds, and troubleshooting.

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
See [distributed resource coherence](https://el37628.github.io/FluxFast-Docs/distributed-cache/) for namespace,
failure, serialization, metrics, lifecycle, security, and background-publisher
guidance.

## Packages

- [`fluxfast` (Python)](https://el37628.github.io/FluxFast-Docs/python-api/) (`python/fluxfast`): FastAPI routes, resource engine, type and resource contract
  registries, process-local and Redis scoped server caches, live coordination,
  and mutation helpers.
- [`@fluxfast/core`](https://el37628.github.io/FluxFast-Docs/core-api/) (`packages/core`): framework-neutral browser runtime with no React or Next.js
  imports, providing the resource store, router, and dependency-free native
  validation engine, plus an explicit server-only adapter entry.
- [`@fluxfast/codegen`](https://el37628.github.io/FluxFast-Docs/codegen-api/) (`packages/codegen`): shared schema/type/validator/route/mutation compiler,
  explicit Next/React registries, and read-only generation checks.
- [`@fluxfast/react`](https://el37628.github.io/FluxFast-Docs/react-api/) (`packages/react`): shared React bindings and explicit SSR/hydration boundaries.
- [`@fluxfast/vite`](https://el37628.github.io/FluxFast-Docs/vite-host/) (`packages/vite`): complete React SSR host with initialization, one-origin HMR,
  client/SSR production build and artifact-only startup.
- [`@fluxfast/next`](https://el37628.github.io/FluxFast-Docs/next-api/) (`packages/next`): Next.js 16 App Router adapter and onboarding CLI, reusing
  shared React bindings and Codegen while retaining existing application imports.
- [`@fluxfast/devtools`](https://el37628.github.io/FluxFast-Docs/devtools/) (`packages/devtools`): optional development-only Debugbar and bounded runtime
  inspector for resources, timelines, caches, mutations, live state, and
  protocol metadata.

## Documentation

The [documentation website](https://el37628.github.io/FluxFast-Docs/) includes
complete examples, expected API outputs, and searchable reference pages.

### Learn and build

- [Introduction](https://el37628.github.io/FluxFast-Docs/introduction/)
- [Getting Started](https://el37628.github.io/FluxFast-Docs/getting-started/)
- [Getting Started with React/Vite](https://el37628.github.io/FluxFast-Docs/react-getting-started/)
- [Architecture](https://el37628.github.io/FluxFast-Docs/architecture/)
- [Resources and Mutations: API Walkthrough](https://el37628.github.io/FluxFast-Docs/api-walkthrough/)
- [Mutations](https://el37628.github.io/FluxFast-Docs/mutations/)
- [Caching](https://el37628.github.io/FluxFast-Docs/caching/)
- [Deferred Resources](https://el37628.github.io/FluxFast-Docs/deferred-resources/)
- [Live Resources](https://el37628.github.io/FluxFast-Docs/live-resources/)
- [General Application Contracts](https://el37628.github.io/FluxFast-Docs/contracts/)
- [Generated Contracts](https://el37628.github.io/FluxFast-Docs/type-safety/)
- [Generated Artifact Contract](https://el37628.github.io/FluxFast-Docs/generated-artifacts/)
- [Validation](https://el37628.github.io/FluxFast-Docs/validation/)

### APIs and frontend integration

- [Stable APIs](https://el37628.github.io/FluxFast-Docs/stable-apis/)
- [Advanced Stable APIs](https://el37628.github.io/FluxFast-Docs/advanced-stable-apis/)
- [Advanced API Walkthrough](https://el37628.github.io/FluxFast-Docs/advanced-api-walkthrough/)
- [Python API](https://el37628.github.io/FluxFast-Docs/python-api/)
- [Core API](https://el37628.github.io/FluxFast-Docs/core-api/)
- [Next.js API](https://el37628.github.io/FluxFast-Docs/next-api/)
- [Next.js Adapter](https://el37628.github.io/FluxFast-Docs/nextjs-adapter/)
- [Manual Next.js Setup](https://el37628.github.io/FluxFast-Docs/nextjs-manual-setup/)
- [React API](https://el37628.github.io/FluxFast-Docs/react-api/)
- [React SSR](https://el37628.github.io/FluxFast-Docs/react-ssr/)
- [React/Vite SSR Host](https://el37628.github.io/FluxFast-Docs/vite-host/)
- [Frontend Adapter Contract](https://el37628.github.io/FluxFast-Docs/adapter-contract/)
- [Server Adapter API Walkthrough](https://el37628.github.io/FluxFast-Docs/server-api-walkthrough/)
- [Shared Codegen API](https://el37628.github.io/FluxFast-Docs/codegen-api/)
- [Codegen API Walkthrough](https://el37628.github.io/FluxFast-Docs/codegen-api-walkthrough/)
- [DevTools](https://el37628.github.io/FluxFast-Docs/devtools/)

### Deploy and upgrade

- [Production](https://el37628.github.io/FluxFast-Docs/production/)
- [Containers](https://el37628.github.io/FluxFast-Docs/containers/)
- [Distributed Redis](https://el37628.github.io/FluxFast-Docs/distributed-cache/)
- [Live Deployment](https://el37628.github.io/FluxFast-Docs/live-deployment/)
- [Versions and Upgrading](https://el37628.github.io/FluxFast-Docs/version-guide/)
- [Stability Guarantees](https://el37628.github.io/FluxFast-Docs/stability/)
- [Versioning Policy](https://el37628.github.io/FluxFast-Docs/versioning/)
- [Migration Guide](https://el37628.github.io/FluxFast-Docs/migration/)
- [FluxFast 1.2 Release Notes](https://el37628.github.io/FluxFast-Docs/releases/v1-2-0/)
- [FluxFast 1.1 Release Notes](https://el37628.github.io/FluxFast-Docs/releases/v1-1-0/)
- [FluxFast 1.0 Release Notes](https://el37628.github.io/FluxFast-Docs/releases/v1-0-0/)
- [FluxFast 1.0 Final Candidate Gate](https://el37628.github.io/FluxFast-Docs/releases/v1-0-final-candidate-gate/)
- [FluxFast 1.0 Artifact Verification](https://el37628.github.io/FluxFast-Docs/releases/v1-0-artifact-verification/)
- [v0.9 → v1.0 Upgrade Guide](https://el37628.github.io/FluxFast-Docs/upgrade-v1/)

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

Read [architecture](https://el37628.github.io/FluxFast-Docs/architecture/), [protocol](https://el37628.github.io/FluxFast-Docs/protocol/),
[stability contract](https://el37628.github.io/FluxFast-Docs/stability/),
[developer schema](https://el37628.github.io/FluxFast-Docs/developer-schema/),
[caching](https://el37628.github.io/FluxFast-Docs/caching/), [distributed resource
coherence](https://el37628.github.io/FluxFast-Docs/distributed-cache/), [deferred
resources](https://el37628.github.io/FluxFast-Docs/deferred-resources/), [Live Resources](https://el37628.github.io/FluxFast-Docs/live-resources/),
[typed contracts](https://el37628.github.io/FluxFast-Docs/type-safety/), [general application
contracts](https://el37628.github.io/FluxFast-Docs/contracts/), [native client validation](https://el37628.github.io/FluxFast-Docs/validation/),
[migration guide](https://el37628.github.io/FluxFast-Docs/migration/),
[Next.js integration](https://el37628.github.io/FluxFast-Docs/nextjs-adapter/), [production
deployment](https://el37628.github.io/FluxFast-Docs/production/), [containers](https://el37628.github.io/FluxFast-Docs/containers/), and
[mutations](https://el37628.github.io/FluxFast-Docs/mutations/) before extending a wire, schema, cache, or
deployment boundary. The [compatibility and versioning
policy](https://el37628.github.io/FluxFast-Docs/versioning/) lists supported runtimes and release rules; the
[stability contract](https://el37628.github.io/FluxFast-Docs/stability/) defines the public boundary,
compatibility meaning, and deprecation policy; the [Python public API
contract](https://el37628.github.io/FluxFast-Docs/python-api/) classifies every
official top-level export, and the [`@fluxfast/core` API
contract](https://el37628.github.io/FluxFast-Docs/core-api/) classifies the framework-neutral runtime. The
[`@fluxfast/next` API contract](https://el37628.github.io/FluxFast-Docs/next-api/) defines the supported adapter
exports and package paths, while the [DevTools guide](https://el37628.github.io/FluxFast-Docs/devtools/) defines
the optional `@fluxfast/devtools` root API and diagnostics boundary. Maintainers
can find the registry and tag procedure in the [release guide](https://el37628.github.io/FluxFast-Docs/releasing/).

FluxFast is not an Inertia wrapper and does not implement the Inertia protocol.
