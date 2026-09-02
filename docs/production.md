# Production deployment

FluxFast runs a FastAPI application and a Next.js application as one production
service. An external process manager starts one foreground `fluxfast start`
process; FluxFast supervises the two runtimes behind one public Next.js origin.

```text
browser or load balancer
        |
        | public HTTP
        v
Next.js 0.0.0.0:3000
        |
        | server-only FluxFast transport
        v
FastAPI 127.0.0.1:8123
```

FastAPI still owns application routes, authorization, validation, resources,
and mutations. The browser never needs the private backend address, so the
standard topology needs neither a second public port nor CORS configuration.
See [ADR-0007](decisions/0007-production-runtime.md) for the architectural
decision.

## Prepare and build

Install the Python and frontend dependencies before building. The frontend must
be initialized with `@fluxfast/next` and define non-empty `build` and `start`
scripts. FluxFast detects pnpm, Yarn, Bun, or npm from the frontend lockfile,
then the `packageManager` field; it defaults to npm when neither is present.
The selected package manager and local package binaries must already be on
`PATH`. Production commands never download dependencies.

Generate typed contracts during development, commit the generated files, and
check them in CI:

```bash
fluxfast types backend.main:app --frontend frontend
fluxfast types backend.main:app --frontend frontend --check
```

Create the production Next.js output explicitly:

```bash
fluxfast build --app backend.main:app --frontend frontend
```

Supplying `--app` makes the build validate the backend schema against the
committed generated files before it invokes the frontend's existing `build`
script. Without `--app`, FluxFast still checks adapter initialization and the
generated page registry. `fluxfast start` never builds or generates files; a
missing `.next/BUILD_ID` fails with an instruction to run `fluxfast build`.

## Validate and start

Inspect the finished artifact without modifying it:

```bash
fluxfast doctor --production \
  --app backend.main:app \
  --frontend frontend \
  --strict
```

Strict mode treats production-risk warnings, including process-local cache or
Live Resource coordination with multiple workers, as blocking. Run it in the
same environment and from the same artifact that will be deployed.

Start the service in the foreground:

```bash
fluxfast start backend.main:app \
  --frontend frontend
```

The supervisor starts FastAPI first, waits for its private readiness endpoint,
starts Next.js, and waits for the public listener. It reports `application
ready` only after that sequence succeeds. It sets `NODE_ENV=production`, starts
Uvicorn without reload, injects `FLUXFAST_BACKEND_URL` into the Next.js child as
server-only configuration, and removes `NEXT_PUBLIC_FLUXFAST_BACKEND_URL` from
that child's environment.

Do not run `uvicorn` and `next start` as separate services for the ordinary
deployment. Advanced deployments may do so, but then they own the private
transport, supervision, health, and shutdown behavior that `fluxfast start`
normally provides.

## Configuration

Command-line options take precedence over environment variables. Defaults are
safe for the single-origin topology:

| CLI option | Environment | Default | Purpose |
| --- | --- | --- | --- |
| `--host` | `FLUXFAST_HOST` | `0.0.0.0` | Public Next.js bind address |
| `--port` | `FLUXFAST_PORT`, then `PORT` | `3000` | Public Next.js port |
| `--backend-host` | `FLUXFAST_BACKEND_HOST` | `127.0.0.1` | Private FastAPI bind address |
| `--backend-port` | `FLUXFAST_BACKEND_PORT` | `8123` | Private FastAPI port |
| `--workers` | `FLUXFAST_WORKERS` | `1` | Uvicorn worker count |
| `--startup-timeout` | `FLUXFAST_STARTUP_TIMEOUT` | `30` seconds | Per-child readiness deadline |
| `--shutdown-timeout` | `FLUXFAST_SHUTDOWN_TIMEOUT` | `20` seconds | Shared graceful-stop deadline |

`FLUXFAST_APP` can supply the application import to `fluxfast doctor` when
`--app` is omitted. `fluxfast start` deliberately requires its positional
`MODULE:ATTRIBUTE` application import.

Keep the backend on loopback unless a deliberately non-standard topology needs
external access. `fluxfast doctor --production` warns when it is not loopback.
Do not pass database, Redis, or application secrets through `NEXT_PUBLIC_*`
variables. Supply secrets through the host, container runtime, or deployment
platform; never commit them to generated files or bake `.env` files into an
image.

## Workers and Redis

`--workers N` delegates the worker pool to Uvicorn. One process may use the
default `MemoryResourceCache` and `MemoryLiveBroker`. With multiple workers or
multiple application instances:

- use `RedisLiveBroker` when Live Resource signals must reach every worker;
- use `RedisResourceCache` for shared positive-TTL values and invalidation; or
- keep live resources at `ttl=0` if the resource cache intentionally remains
  process-local.

Every cooperating process must use the same Redis database, cache namespace,
and broker channel prefix. Use different namespaces for different applications
and environments. Redis is infrastructure, not part of the public FluxFast
service. See [distributed resource coherence](distributed-cache.md) for the
configuration and failure contract.

## Health and readiness

Probe through the public origin so the result covers both Next.js and its
private connection to FastAPI:

| Path | Success | Not ready |
| --- | --- | --- |
| `GET /_fluxfast/healthz` | `200 {"status":"ok"}` | `503 {"status":"not_ready"}` when the private probe cannot be validated |
| `GET /_fluxfast/readyz` | `200 {"status":"ready"}` | `503 {"status":"not_ready"}` |

Both responses use `Cache-Control: no-store` and intentionally omit PIDs,
ports, paths, resource identities, Redis details, and credentials. Readiness is
false until FastAPI initialization completes, while shutdown is in progress,
or when a configured FluxFast-owned dependency with a bounded `healthcheck()`
fails. Arbitrary application databases and services remain application-owned.

Use readiness—not liveness—to decide when a new instance may receive traffic.
The public probe also prevents a load balancer from accepting an instance whose
Next.js process is alive but cannot reach FastAPI.

## Shutdown, failures, and logs

Run `fluxfast start` as the foreground process. It works under an ordinary
shell, systemd, supervisord, aaPanel, Docker, and Podman. Child stdout and
stderr stay attached to the supervisor, so the outer platform owns log
collection and rotation.

SIGTERM or SIGINT starts an idempotent shutdown. FluxFast stops Next.js and
FastAPI process groups, waits within the configured shared shutdown deadline,
and kills a child that does not exit. A requested clean shutdown exits `0`. If
either child exits unexpectedly, FluxFast stops its sibling and exits non-zero;
it never intentionally leaves half of the application running.

Common `fluxfast start` status codes are:

| Status | Meaning |
| ---: | --- |
| `0` | Requested clean shutdown |
| `1` | A supervised child exited unexpectedly |
| `2` | Invalid production configuration |
| `3` | Project, runtime, package-manager, or process validation failed |
| `4` | A child failed to become ready within the startup timeout |
| `5` | The production Next.js build is missing |

Supervisor messages are prefixed with `[fluxfast]`. Do not parse human log
text as a health API; use the public probe paths.

## Process managers and aaPanel

Configure an external process manager to run the top-level FluxFast command,
keep it in the foreground, send SIGTERM during stop, and respect a stop grace
period longer than `FLUXFAST_SHUTDOWN_TIMEOUT`. For example:

```bash
fluxfast start backend.main:app \
  --frontend /srv/my-app/frontend \
  --host 0.0.0.0 \
  --port 3000
```

When aaPanel requires a project category, use a Node.js project because the
public-facing process is Next.js, but make its start command the command above.
Do not create a second aaPanel project for FastAPI and do not configure aaPanel
to run only `next start`.

FluxFast does not generate systemd, supervisord, or aaPanel configuration. Set
the working directory, environment, user, restart policy, and log destination
using the platform's normal facilities.

## Reverse proxies and Live Resource streams

A reverse proxy or load balancer should target only the public Next.js port. It
must forward the request method and body, preserve the effective host and
FluxFast request headers, and terminate HTTPS according to the platform's own
documentation.

Live Resources use fetch-based Server-Sent Events. Every intermediary must:

- allow long-lived HTTP responses and propagate disconnects;
- stream response bytes without buffering;
- avoid caching or indefinitely buffering transformations/compression for
  `text/event-stream`;
- preserve cookies, authorization, and `X-FluxFast-*` request headers; and
- use an idle timeout safely above the configured heartbeat interval.

FluxFast emits `Content-Type: text/event-stream`, `Cache-Control: no-cache,
no-transform`, and `X-Accel-Buffering: no` for the stream. No WebSocket upgrade
is required. FluxFast intentionally does not ship proxy-provider
configuration; follow the provider's current TLS, forwarding, and streaming
documentation. See [deploying Live Resources](live-deployment.md) for Nginx
and Nginx Proxy Manager examples.

## Upgrades and horizontal deployment

The basic upgrade is build a new immutable artifact, stop the old service, and
start the new one. FluxFast does not provide a zero-downtime or rolling
orchestrator. A deployment platform may instead:

1. start the new instance;
2. wait for its public `/_fluxfast/readyz` response;
3. send new traffic to it and drain the old instance; and
4. send SIGTERM to the old supervisor.

Multiple FluxFast instances each expose one public port and supervise their own
private FastAPI runtime. Put them behind the platform load balancer and use the
same explicitly namespaced Redis configuration when cache or live coherence
must cross instances.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `No Next.js production build found` | Run `fluxfast build --app ... --frontend ...` in the artifact build phase. |
| Package-manager executable missing | Install the manager selected by the frontend lockfile and put it on `PATH`. |
| Frontend `start` script rejected | Define a non-empty `scripts.start`, normally `next start`. |
| Public readiness is `503` | Inspect FastAPI startup and FluxFast-owned Redis/cache health before exposing the instance. |
| Browser tries a backend origin | Remove browser-facing backend URLs and start the app through `fluxfast start`. |
| Live updates arrive in bursts | Disable proxy buffering/caching and exclude SSE from buffering compression. |
| Multi-worker updates diverge | Run the strict production doctor and configure the required Redis cache/broker topology. |
| Shutdown is forcibly killed | Increase the outer platform grace period or the FluxFast timeout after measuring real cleanup. |

For container-specific operation, continue with [container deployment](containers.md).
