# Getting started with React and Vite

This walkthrough builds a server-rendered React application from an empty
directory. FastAPI owns both URLs and a typed resource; React renders the
server-selected components. Vite supplies development compilation and HMR.
One Python command starts the whole application on one public browser origin,
without a browser backend URL, React Router, or CORS configuration.

This host is introduced in **FluxFast 1.2**. These registry installation commands
require 1.2.0 to have been published; check the
[versioned release notes](releases/v1.2.0.md#confirm-publication) first. A source
checkout or an unreleased API page does not prove registry availability.
Existing Next.js applications can keep their setup and imports; use the
[Next.js walkthrough](getting-started.md) for that host.

## 1. Install matching packages

Use Python 3.11–3.14, Node.js 22.12+ or 24, React/React DOM 19, and Vite
`>=7.3.6 <8`. The commands use npm; pnpm is not required in your application.

```bash
mkdir hello-fluxfast-react
cd hello-fluxfast-react
python -m venv .venv
source .venv/bin/activate
python -m pip install "fluxfast==1.2.0"
mkdir -p backend frontend/src
cd frontend
npm init -y
npm pkg set type=module
npm install @fluxfast/core@1.2.0 @fluxfast/react@1.2.0 react@19 react-dom@19
npm install --save-dev @fluxfast/codegen@1.2.0 @fluxfast/vite@1.2.0 \
  vite@7.3.6 typescript@7 @types/node@22 @types/react@19 @types/react-dom@19
```

Core/React are application dependencies; Codegen and Vite are build tools. Keep
`@fluxfast/vite` installed for the production host executable: production startup
does not import the Vite compiler, but it does execute `fluxfast-vite start`.
See [production packaging](vite-host.md#production-output-and-request-behavior) before
pruning dependencies in a container.

Create `frontend/tsconfig.json` while still in `frontend/`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node", "react", "react-dom"]
  },
  "include": ["src"]
}
```

Explicit `types` also makes this example work with TypeScript 7. Initialize
using the installed executable, then return to the project root:

```bash
npm exec --no -- fluxfast-vite init --yes
cd ..
```

The initializer creates a dedicated `fluxfast.vite.config.mjs`, `fluxfast.html`,
page registry, starter component, scoped `fluxfast:dev/build/start` scripts,
and generated agent knowledge. It preserves existing SPA entry points, scripts,
and user instructions. It does not start services or install packages.

## 2. Define URLs and data in FastAPI

Create `backend/main.py`:

```python
from fastapi import FastAPI
from fluxfast import FluxFast, Page, resource, scope
from pydantic import BaseModel

app = FastAPI()
flux = FluxFast(app)


class Greeting(BaseModel):
    message: str
    author: str


GREETING = flux.define_resource("greeting", Greeting)


def greeting_resource():
    return resource(
        GREETING,
        lambda: {"message": "Hello from FastAPI", "author": "FluxFast"},
        scope=scope.public(),
        ttl=30,
    )


@flux.page("/", name="home")
async def home() -> Page:
    return Page(component="home/index", resources=[greeting_resource()])


@flux.page("/about", name="about")
async def about() -> Page:
    return Page(component="about/index", resources=[greeting_resource()])
```

`GREETING` binds the resource key to its authoritative Pydantic contract.
`Page.component` selects an allowlisted frontend module, not an arbitrary import.
Both pages include the same reusable resource; reading it on the frontend does
not itself execute its loader. The explicitly public scope is appropriate only
because this example contains no private data. Use user/tenant scopes and
FastAPI authorization dependencies for private resources.

## 3. Render the resource in React

Replace `frontend/src/flux-pages/home/index.tsx`:

```tsx
import { Link, useResource } from "@fluxfast/react";
import { resourceKeys } from "../../.fluxfast/types.generated";

export default function HomePage() {
  const greeting = useResource(resourceKeys.greeting);
  return (
    <main>
      <h1>{greeting.message}</h1>
      <p>By {greeting.author}</p>
      <Link href="/about">About this app</Link>
    </main>
  );
}
```

Create `frontend/src/flux-pages/about/index.tsx`:

```tsx
import { Link, useResource } from "@fluxfast/react";
import { resourceKeys } from "../../.fluxfast/types.generated";

export default function AboutPage() {
  const greeting = useResource(resourceKeys.greeting);
  return (
    <main>
      <h1>About this app</h1>
      <p>{greeting.author} renders FastAPI-owned resources with React.</p>
      <Link href="/">Back home</Link>
    </main>
  );
}
```

These files need no Next.js `"use client"` directive or Next dependency.
`resourceKeys.greeting` infers the generated `Greeting` type. The generated
imports become available in the next step; do not create those files by hand.
`Link` renders an ordinary anchor and intercepts eligible internal clicks for
FluxFast navigation. FastAPI still decides the destination and its resources.

## 4. Generate and check the authoritative contract

From the project root, with the Python environment active:

```bash
fluxfast types backend.main:app --frontend frontend --adapter react
fluxfast types backend.main:app --frontend frontend --adapter react --check
cd frontend
npm exec --no -- tsc --noEmit
npm exec --no -- fluxfast-vite doctor
cd ..
```

Python exports the real schema; installed Codegen generates the manifest, types,
validators, routes, mutations, and React page allowlist under `src/.fluxfast`.
The read-only check exits successfully when they are current and fails on drift
without rewriting them. `--adapter react` is optional here because the frontend
declares `@fluxfast/vite`. The generated type is equivalent to:

```ts
export interface Greeting {
  author: string;
  message: string;
}
```

See the [generated-artifact contract](generated-artifacts.md) for filenames,
type naming and CI rules. Regenerate whenever you change backend contracts or
add/remove page modules; do not edit generated artifacts.

## 5. Run and inspect the result

```bash
fluxfast dev backend.main:app --frontend frontend
```

Open `http://127.0.0.1:3000`. The initial document already contains:

```text
Hello from FastAPI
By FluxFast
About this app
```

React hydrates the same initial envelope without fetching it a second time.
Click **About this app** and **Back home**, then use browser Back/Forward.
These transitions use FluxFast rather than a new document request. Edit a page's
text: Vite updates it automatically through the same public origin.

In another terminal you can inspect the actual page API (this is an abbreviated
response; resource versions are generated values, not fixed strings):

```bash
curl -s http://127.0.0.1:3000/ \
  -H 'X-FluxFast: 1' -H 'X-FluxFast-Protocol: 1'
```

```json
{
  "protocol": "fluxfast/1",
  "page": { "component": "home/index", "url": "/" },
  "resources": {
    "greeting": {
      "version": "<server-generated-version>",
      "value": { "message": "Hello from FastAPI", "author": "FluxFast" }
    }
  }
}
```

An ordinary request receives HTML; the protocol headers request a FluxFast
envelope. A nonexistent backend URL returns HTTP 404. Python supervises a private
FastAPI process and the public React/Vite host; you start neither separately and
put no backend address in `VITE_*` variables or browser code.

## 6. Build once, start the production artifact

Stop development with Ctrl+C, then run:

```bash
fluxfast build --app backend.main:app --frontend frontend
fluxfast doctor --production --app backend.main:app --frontend frontend --strict
fluxfast start backend.main:app --frontend frontend
```

Open the same public origin. Production uses `dist/fluxfast/host.json`, its
client assets and compiled SSR renderer. Startup does not build, generate
contracts, evaluate source Vite configuration, or require page source files.
`doctor --strict` checks configuration and installed versions without repairing
them. Build again after changing source or contracts.

The in-memory cache and single-worker setup above are intentionally small.
For multiple workers, use [distributed cache](distributed-cache.md) and
[live deployment](live-deployment.md); for worker counts, ports, reverse proxies
and shutdown, see [production deployment](production.md).

## Next steps and troubleshooting

- Add forms and mutations with `useForm`, generated validators and FastAPI
  mutation handlers: [React API examples](react-api.md) and
  [general contracts](contracts.md). Substitute `@fluxfast/react` for the shared
  hook imports in Next-oriented examples; do not copy Next config or route files.
- Load noncritical data after the shell or keep it live:
  [deferred resources](deferred-resources.md) and [live resources](live-resources.md).
- For existing SPA configuration, custom host options, assets or dependency
  pruning, use the [Vite host reference](vite-host.md).
- If a local executable is missing, install matching packages in `frontend`;
  `npm exec --no` deliberately does not download a replacement from the registry.
- If Python selects Next or reports an ambiguous host, check the owning frontend
  manifest: use `@fluxfast/vite` for React and keep Next in a separate frontend.
- If production reports a missing/stale artifact, regenerate/check contracts and
  rebuild. Do not start a development server as a production fallback.
