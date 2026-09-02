# Next.js Adapter

FluxFast supports Next.js 16.3+ with React 19 and the App Router. FastAPI remains
the application router; Next.js supplies the document, bundling, React runtime,
and code splitting through one optional catch-all shell.

## Automatic setup

Run the initializer from an existing Next.js application:

```bash
npm install @fluxfast/next
npx fluxfast init
```

The initializer detects TypeScript or JavaScript and `src/` or root layout,
validates the installed packages and App Router, then prepares:

```text
src/flux-pages/
src/fluxfast.config.ts
src/app/(flux)/[[...flux]]/page.tsx
src/.fluxfast/pages.generated.ts
next.config.ts
```

For a root-layout or JavaScript project it uses the corresponding root paths and
file extensions. Existing FluxFast configuration is preserved, and an existing
`withFluxFast()` wrapper is not duplicated. Running `init` again is safe and
regenerates the page registry.

Preview the exact file plan without writing anything:

```bash
npx fluxfast init --dry-run
```

Check whether setup is complete without modifying files:

```bash
npx fluxfast init --check
```

The standard Create Next App home page can be migrated to
`flux-pages/home/index`. A custom page or a page using Server Component APIs is
left untouched; the command reports the manual action and exits nonzero rather
than risking user code. Resolve the route conflict and run `init` again.

## CLI commands

| Command | Purpose |
| --- | --- |
| `npx fluxfast init` | Analyze, configure, and generate the frontend scaffold. |
| `npx fluxfast init --dry-run` | Show the initialization plan without writes. |
| `npx fluxfast init --check` | Return success only when configuration is complete. |
| `npx fluxfast init --force` | Replace an invalid or customized FluxFast catch-all with the generated template. |
| `npx fluxfast generate` | Regenerate the page registry and schema-backed TypeScript artifacts. |
| `npx fluxfast generate --check` | Check every generated frontend artifact without writing. |
| `npx fluxfast doctor` | Diagnose packages, layout, routes, config, pages, and registry freshness. |

`init --check` and `doctor` are read-only and return a nonzero exit status when
they find a blocking problem, which makes either command suitable for CI.
`doctor` also prints registered component names and actionable repair commands.

## Typed contract generation

From a directory that can import the FastAPI application, generate the backend
manifest and all frontend TypeScript artifacts together:

```bash
fluxfast types backend.main:app --frontend frontend
```

If the frontend is the current directory, omit `--frontend`. The Python CLI
owns application import and Pydantic serialization-schema export. It passes a
temporary manifest to the frontend's locally installed `@fluxfast/next` CLI,
which detects the root or `src/` layout and compiles the manifest, resource
types, route builders, mutation helpers, and page registry before writing any
of them. Page handlers, resource loaders, dependencies, and mutation handlers
are not executed during export.

Use the read-only form in CI to detect changes to either backend contracts or
frontend pages:

```bash
fluxfast types backend.main:app --frontend frontend --check
```

A stale or missing manifest or generated file returns a nonzero status and is
left untouched. The helper selects npm, pnpm, Yarn, or Bun from the frontend
lockfile or `packageManager` field and runs its local FluxFast executable.

The detected `.fluxfast` directory contains:

| Generated file | Frontend API |
| --- | --- |
| `schema.generated.json` | Validated `fluxfast-schema/1` manifest and fingerprint. |
| `types.generated.ts` | Resource models, `resourceKeys`, and hook inference. |
| `routes.generated.ts` | Typed FastAPI page URL builders. |
| `mutations.generated.ts` | Typed JSON helpers that reuse `FluxRouter.mutate()`. |
| `pages.generated.ts` | Allowlisted lazy page-component registry. |

Do not edit these files manually. The complete declaration, generation,
frontend usage, compatibility, and drift workflow is documented in [typed
resource contracts and code generation](type-safety.md).

## Development

From the directory that can import the FastAPI application, run:

```bash
fluxfast dev backend.main:app --frontend frontend
```

If the frontend is the current directory, omit `--frontend`:

```bash
fluxfast dev backend.main:app
```

The supervisor selects an available FastAPI loopback port, injects that address
only into the Next server process, and starts the frontend on port 3000. The
browser uses relative URLs on the Next origin; the `X-FluxFast: 1` rewrite sends
only protocol visits and mutations to FastAPI. Normal document requests remain
owned by the Next catch-all shell, so local development needs one command, one
public port, and no CORS configuration.

The supervisor selects npm, pnpm, Yarn, or Bun from the frontend lockfile, then
falls back to the `packageManager` field and finally npm. Override the public
port with `--frontend-port` when needed.

## Adapter configuration

The generated Next config wraps the existing supported config shape:

```js
import { withFluxFast } from "@fluxfast/next/next-config";

export default withFluxFast({
  reactStrictMode: true,
});
```

`withFluxFast()` generates the allowlisted lazy registry and installs the
same-origin protocol rewrite. The generated registry exports `fluxPages` and a
client-side `FluxApplication`. Tests, stories, and underscore-prefixed modules
are ignored. Page paths may use ASCII letters, digits, `_`, `.`, `@`,
parentheses, brackets, and hyphens, with `/` between directories and a `.tsx`
or `.jsx` extension. Generation rejects other characters before emitting import
paths into source.

The generated FluxFast config connects the registry to the runtime:

```ts
import { defineFluxConfig } from "@fluxfast/next";
import { FluxApplication } from "@/.fluxfast/pages.generated";

export const fluxConfig = defineFluxConfig({
  application: FluxApplication,
});
```

The catch-all obtains the initial FastAPI envelope on the server:

```tsx
import { createFluxNextPage } from "@fluxfast/next/server";
import { fluxConfig } from "@/fluxfast.config";

export const dynamic = "force-dynamic";

export default createFluxNextPage(fluxConfig);
```

The helper reconstructs the path and repeated search parameters, forwards only
cookie, authorization, accept-language, user-agent, and explicitly configured
safe headers, and never forwards hop-by-hop headers.

`backendUrl` is server-visible and normally comes from the development
supervisor. `clientUrl` is the browser transport base; omit it for the default
same-origin setup. Set either value explicitly only for a deliberate deployment
where the Next server or browser must reach a separate backend address. A
cross-origin browser deployment requires explicit FastAPI CORS configuration.

`Link` renders a normal anchor and intercepts only unmodified left clicks to
same-origin destinations with `_self` targeting and no download attribute.
`usePage`, `useResource`, `useResourceState`, `useDeferredResource`, `useForm`,
`useRouter`, and `useFlux` consume the stable client runtime. Use
`useDeferredResource` when a key may be pending or failed; its lifecycle and
targeted retry behavior are documented in the [deferred resources
guide](deferred-resources.md). When `types.generated.ts` is present, the three
resource hooks infer known literal keys through `FluxResourceMap`; dynamic keys
remain `unknown`, and explicit generic overrides remain supported.

## Troubleshooting

- Run `npx fluxfast doctor` first; it detects unsupported package versions,
  route conflicts, missing config, and a stale registry.
- If `app/page.*` remains after initialization, it shadows the FluxFast `/`
  route. Move the component to `flux-pages/home/index.*`, make it client-safe,
  and remove the App Router page.
- If a new page is missing from the registry, run `npx fluxfast generate` and
  commit the generated file only when the consuming project tracks generated
  output.
- If `next.config` uses an unknown wrapper or export expression, FluxFast leaves
  it unchanged. Follow the wrapper-order guidance in the
  [manual setup guide](nextjs-manual-setup.md).
- If the generated catch-all is invalid, inspect its diff and run
  `npx fluxfast init --dry-run --force`, then `npx fluxfast init --force` to
  replace it. The flag changes only how an existing catch-all is handled; the
  rest of the normal initialization plan still applies.
- If the initial envelope returns `404 Not Found`, confirm that FastAPI defines
  the requested path and that its `Page.component` exactly matches a registered
  `flux-pages` component such as `home/index`.
- If an older `@fluxfast/next` version reports `Failed to execute 'measure' on
  'Performance'` with a negative timestamp while rendering a redirect or
  not-found page in development, upgrade the adapter. FluxFast avoids the
  rejected server-component path affected by the confirmed
  [Next.js development issue](https://github.com/vercel/next.js/issues/86060).
  Do not patch the browser Performance API.
- If the browser is calling a second port, remove an unnecessary `clientUrl`
  and start the application through `fluxfast dev`.

For custom monorepos, unsupported Next config syntax, or framework-level
debugging, continue with the [manual setup guide](nextjs-manual-setup.md).
