# Container deployment

FluxFast uses the same OCI image under Docker and Podman. The image contains
Python, Node.js, the FastAPI application, the production Next.js output, and the
FluxFast supervisor. It is one application container even though it runs two
internal runtimes.

```text
FluxFast application container
  |-- fluxfast start (PID 1)
  |-- Next.js        0.0.0.0:3000  public
  `-- FastAPI        127.0.0.1:8123 private

external Redis/database services, only when the application needs them
```

Only port `3000` is exposed. Do not split the reference application into
frontend and backend containers merely because it has two child processes.
The [production guide](production.md) describes the runtime contract; the
repository [Dockerfile](../Dockerfile) and [Compose file](../compose.yaml) are
executable reference deployments used by integration tests.

## Image lifecycle

A production image should use separate build and runtime stages:

```text
copy lockfiles and manifests
  -> install dependencies deterministically
  -> copy application source
  -> fluxfast types ... --check
  -> fluxfast build ...
  -> copy only runtime dependencies and built output
  -> run fluxfast start
```

Adapt the repository Dockerfile's application import and paths to the consuming
project. Keep these properties:

- use OCI-compatible instructions and a pinned, supported runtime base;
- install both Python and Node.js runtime requirements during image build;
- use a lockfile and the matching package manager;
- validate generated contracts and build Next.js in the build stage;
- copy the required Python application and Next.js runtime output;
- set `NODE_ENV=production` and run as an unprivileged UID/GID;
- expose only the public application port;
- use the exec-form `fluxfast start` command as PID 1; and
- do not install packages, generate source, or build at container startup.

Next.js standalone output can reduce what must be copied into the runtime
stage. The exact output layout belongs to the consuming Next.js configuration;
verify the finished image rather than assuming a source checkout will exist at
runtime.

Use a `.dockerignore` that excludes at least `.git`, `.github`, local
`node_modules`, `.next`, virtual environments, Python caches, coverage output,
logs, and `.env*` secrets. Allow a deliberately safe environment template only
when it is meant to be public.

## Docker

Build and run the image with one public mapping:

```bash
docker build --tag my-fluxfast-app:0.7.0 .

docker run --rm \
  --name my-fluxfast-app \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish 127.0.0.1:3000:3000 \
  --env-file /run/secrets/my-fluxfast-app.env \
  my-fluxfast-app:0.7.0
```

Binding the host side to `127.0.0.1` is useful when a host reverse proxy is the
only public entry point. Use the deployment platform's private network and
firewall model when the load balancer is remote. Never publish the private
FastAPI port.

The read-only filesystem, bounded `/tmp`, dropped capabilities, and
`no-new-privileges` settings match the reference security tests. Add writable
mounts only for application-owned data that genuinely must persist; prefer an
external database or object store over mutating the application image.

## Rootless Podman

Build and run the same definition as an ordinary user:

```bash
podman build --tag my-fluxfast-app:0.7.0 .

podman run --rm \
  --name my-fluxfast-app \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish 127.0.0.1:3000:3000 \
  --env-file /run/secrets/my-fluxfast-app.env \
  my-fluxfast-app:0.7.0
```

The image must not require root, privileged mode, host networking, access to a
Docker socket, or a Docker-specific runtime API. Port `3000` is unprivileged
and works naturally with rootless networking. If the Docker and Podman image
size commands report different values, compare repeated measurements within
the same engine; their local storage accounting is not identical.

## Compose and Redis

The reference Compose topology has one application service and, when
distributed coherence is configured, one Redis infrastructure service:

```text
browser -> app:3000 -> private FastAPI workers -> redis:6379
```

Start it with Docker Compose:

```bash
FLUXFAST_COMPOSE_PORT=3000 docker compose up --build
```

Or with a Podman-compatible Compose provider:

```bash
FLUXFAST_COMPOSE_PORT=3000 podman compose up --build
```

The repository Compose file uses `FLUXFAST_WORKERS=3` and `REDIS_URL` for its
distributed integration application. A consuming application must also create
`RedisResourceCache` and `RedisLiveBroker` from that URL with explicit matching
namespaces; setting `REDIS_URL` alone does not silently change the cache or
broker implementation.

Redis and the application database remain separate services. That does not
turn the frontend and backend into separate deployment units: the `app`
container still exposes one origin and supervises both application runtimes.
Pin a supported Redis image and decide persistence, credentials, TLS, backups,
and eviction policy at the infrastructure layer.

## Environment and secrets

Use runtime environment variables for settings that differ between
deployments. Typical non-secret values are:

```env
FLUXFAST_HOST=0.0.0.0
FLUXFAST_PORT=3000
FLUXFAST_BACKEND_HOST=127.0.0.1
FLUXFAST_BACKEND_PORT=8123
FLUXFAST_WORKERS=4
FLUXFAST_STARTUP_TIMEOUT=30
FLUXFAST_SHUTDOWN_TIMEOUT=20
```

Pass Redis credentials, database credentials, and application secrets through
the container platform's secret or environment mechanism. Do not:

- copy `.env` files into the build context or a public image layer;
- put backend secrets in `NEXT_PUBLIC_*` variables;
- encode credentials in generated FluxFast files;
- place secret values in the image command or labels; or
- print credential-bearing URLs in application logs.

An environment file passed to a local engine remains a host secret: restrict
its permissions and do not commit it.

## Health checks

Probe the public application path from inside the container:

```text
http://127.0.0.1:3000/_fluxfast/readyz
```

The reference image uses the Node runtime's built-in `fetch`, so it does not
install `curl` solely for health checks. A successful response is exactly
`200 {"status":"ready"}`. Configure the engine or platform start period to
cover the production startup deadline. Use `/_fluxfast/healthz` for liveness
and `/_fluxfast/readyz` for traffic admission.

Check the running reference container with:

```bash
docker inspect --format '{{json .State.Health}}' my-fluxfast-app
docker exec my-fluxfast-app node -e \
  "fetch('http://127.0.0.1:3000/_fluxfast/readyz').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
```

Substitute `podman` for `docker` when using Podman.

## Signals and filesystem safety

Keep `fluxfast start` as the exec-form container command so it receives
SIGTERM as PID 1. Set the engine stop grace period above
`FLUXFAST_SHUTDOWN_TIMEOUT`; the reference Compose file uses 25 seconds for the
20-second default. FluxFast forwards shutdown to the Next.js and FastAPI
process groups and prevents an orphaned half-service.

Production startup requires only installed dependencies and the existing
Next.js build. It does not regenerate files or mutate application source, so
the reference runtime works with a read-only root filesystem and a writable,
bounded `/tmp`. Test any application-specific libraries against the same
restriction before rollout.

## Production upgrades

Build a new immutable tag instead of changing a running container:

```text
build and verify my-fluxfast-app:NEW
  -> start NEW and wait for /_fluxfast/readyz
  -> move or drain traffic from OLD
  -> stop OLD with SIGTERM
  -> retain the previous immutable tag for rollback
```

Docker Compose performs a stop/start replacement and is not a zero-downtime
orchestrator. A load balancer or deployment platform can operate multiple
instances for rolling replacement. Each instance exposes one public port and
uses the same version-compatible Redis namespace when distributed state must be
shared. Rotate the cache namespace or invalidate affected entries when a
release changes the serialized shape of positive-TTL resources.

Before promotion, verify the image under the engine used in production:

- the configured user and group are non-root;
- only `3000/tcp` is exposed and only the intended host mapping is published;
- public liveness/readiness return the minimal documented bodies;
- no package installation or source generation happens during startup;
- the root filesystem can remain read-only;
- SIGTERM exits cleanly within the platform grace period; and
- Redis-backed cache and Live Resource behavior crosses every configured
  worker or instance.

The repository's repeatable container measurements are documented in
[benchmarking](benchmarking.md#production-container-scenario).
