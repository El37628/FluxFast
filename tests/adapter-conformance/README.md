# Adapter conformance

This suite defines FluxFast's observable adapter behavior once. Next.js is the
only implemented harness in Phase A; other adapters can reuse the expectations
without duplicating or weakening them. This does not implement a React/Vite host.

The [adapter implementation contract](../../docs/adapter-contract.md) is the
specification for these lifecycle expectations, including document ownership,
same-envelope hydration, resource authority, and production requirements.

## Run locally

From the repository root, install the declared pnpm and Python development
dependencies, then install Chromium once:

```sh
pnpm install --frozen-lockfile
./.venv/bin/python -m pip install -e 'python/fluxfast[dev]'
pnpm --dir tests/browser/frontend exec playwright install --with-deps chromium

pnpm test:adapter-conformance
pnpm test:adapter-conformance:production
```

The root commands build package dependencies and the fixture's scripts check its
authoritative schema and regenerate typed artifacts. The production command
builds first, snapshots frontend inputs, and fails if starting, running, or
stopping the host changes them. Existing `pnpm test:e2e` and
`pnpm test:e2e:production` commands remain aliases.

After dependency builds, select an individual contract without launching a
second host yourself:

```sh
pnpm --dir tests/browser/frontend run test:e2e --grep 'canonical redirect'
```

`FLUXFAST_E2E_PYTHON` selects the Python executable when it is not the root
`.venv/bin/python`. Development owns loopback ports 3100/3101; production owns
3110/3111. Override them with `FLUXFAST_E2E_PORT` and
`FLUXFAST_E2E_BACKEND_PORT`. The harness refuses to attach to an unrelated server,
starts its own foreground process, and checks both ports are released after
graceful shutdown. Forced termination is cleanup, not a passing shutdown result.
Use `FLUXFAST_CONFORMANCE_VERBOSE=1` to show bounded host diagnostics live.

The `Same-origin browser flow` CI job runs both modes. Development-only trace
assertions and production-only deployment assertions are selected explicitly;
their opposite-mode skips do not mean those contracts lack an executing gate.
DevTools UI remains in `tests/browser/frontend/e2e/devtools.spec.ts` and uses
`pnpm test:e2e:devtools`. Redis/multiple-worker topology remains covered separately
by `pnpm test:e2e:distributed` and `pnpm test:e2e:distributed:production`.

## Ownership and fixtures

`contract/` contains framework-independent expectations. Tests use real HTTP,
browser interactions, transport headers/envelopes, and public FluxFast APIs.
They do not import Next/React internals or inspect a framework's private stores.

`harness.ts` describes the lifecycle boundary: `name`, `baseUrl`, `start()`,
`stop()`, and optional `build()`. `process-harness.mjs` owns process readiness,
shutdown, and port checks. `harnesses/next.mjs` contains all Next-specific startup
and build commands; `setup.mjs` starts the selected harness and returns teardown.
The registry rejects unknown harness names rather than silently using Next.

The fixture backend is `tests/browser/backend.py`; its additional contract
scenarios are defined in `tests/browser/conformance.py`. Real FastAPI/Pydantic
loaders and mutations exercise authoritative validation, scoped caches, patches,
and redirects. Unique run identifiers isolate mutable scenario state. The
frontend's `ConformanceProbe` exposes a test-only facade over public Core router,
resource, initial-envelope, and diagnostic APIs when the test opts in. This
instrumentation is not a new product API or adapter implementation requirement.
Diagnostics are subscribed only in development.

A future harness must supply equivalent fixture UI, authoritative backend
scenarios, and the same public-API test facade. Framework-specific setup belongs
in its harness/fixture, not conditional assertions in the shared tests.

## Contract coverage

| Contract | Executing cases |
| --- | --- |
| SSR and hydration | Raw HTML without JavaScript; selected route; duplicate query parameters; forwarded cookie and configured authorization; identical envelope and versions; no duplicate blocking resource fetch; actual HTTP 404; canonical redirect; external redirect rejected before contacting its origin |
| Navigation | Link and public router visits; replace and scroll preservation; Back/Forward; prefetch consumed once; retained and evicted page-cache entries |
| Resources | Initial and shared values; known-version omission; selective refresh; stale data; loader failure and retry; resource LRU eviction |
| Mutations | Authoritative 422; all five patch operations with subscribed UI updates; invalidation and canonical refresh; internal hydrated and explicit external document redirects |
| Deferred | Manifest and pending state; single follow-up; successful resolution; errors/retry; navigation race; late response ignored even if the transport does not honor abort |
| Live | Connection and StrictMode lifecycle cycles; invalidation and patches; origin suppression; user/tenant isolation; offline/reconnect/resynchronization; navigation subscription replacement |
| Diagnostics | Public value-free SSR, navigation, resources, cache, mutation, deferred, and live events without requiring DevTools UI |
| Production | Build and boot; one public origin; private loopback backend; minimal health/readiness; Flux transport and live streaming; hard-navigation SSR; no DevTools traces/UI; graceful shutdown and released ports |

Core regression suites separately enforce security, bounds, protocol validation,
and cancellation semantics. Passing these browser cases does not replace package,
security, release-consumer, benchmark, or distributed-worker gates.
