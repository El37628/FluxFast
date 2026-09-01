# ADR-0007: Model production as one supervised application

Status: accepted.

## Context

A FluxFast application has two runtime processes. FastAPI owns application
routing, resource loading, mutations, typed contracts, cache access, and live
publication. Next.js owns the public application shell, server rendering, and
the browser-facing origin. Development already presents those processes as one
application through `fluxfast dev`, but production deployment currently leaves
developers to build, connect, supervise, and stop them independently.

Requiring separate public frontend and backend services would expose an
implementation detail as deployment architecture. It would also make the
normal browser path depend on a second origin, CORS configuration, and public
FastAPI routing even though the Next.js adapter already proxies FluxFast
transport through the application origin.

The production boundary must work as a normal host process, as PID 1 in an OCI
container, and with multiple Uvicorn workers. It must preserve deterministic
startup, fail as a unit, report useful health without exposing internals, and
shut down within the grace periods used by deployment platforms.

## Decision

FluxFast production deployments are modeled as one externally managed
application with one public Next.js origin and an internally supervised
FastAPI runtime.

The canonical topology is:

```text
external supervisor or container runtime
    |
    `-- fluxfast start
          |-- Next.js production server  0.0.0.0:3000
          `-- Uvicorn/FastAPI             127.0.0.1:8123
```

The public host and port remain configurable, but FastAPI binds to loopback by
default. The FluxFast supervisor injects the private backend URL into the
Next.js child as server-only configuration. A normal browser communicates only
with the Next.js origin for documents, navigation, mutations, deferred
resources, and Live Resource streams. It does not require a public backend URL
or CORS configuration.

### Runtime ownership

`fluxfast start` owns exactly two direct child processes:

- a Uvicorn parent for the configured FastAPI import; and
- the selected package manager's Next.js production start command.

FluxFast does not implement a Python worker pool. When more than one FastAPI
worker is configured, it passes that count to Uvicorn and supervises the
Uvicorn parent. Likewise, it does not replace the Next.js production server.

The production supervisor is intentionally separate from development
supervision. Production never enables Uvicorn reload or `next dev`, and it
sets or validates `NODE_ENV=production`.

### Ordered lifecycle

Startup is ordered rather than optimistic:

```text
validate configuration and build
    -> start FastAPI
    -> wait for backend readiness
    -> start Next.js
    -> wait for the public origin
    -> ready
```

The internal supervisor state is bounded to initialization, backend startup,
backend readiness, frontend startup, readiness, shutdown, stopped, and failed
states. It is not a public process-management framework.

If either child exits unexpectedly, the supervisor terminates the sibling and
exits non-zero. It must never leave half of the application running. SIGTERM
and SIGINT begin a single idempotent shutdown sequence: readiness becomes
false, both children receive a graceful termination signal, and any child that
outlives the configured timeout is killed. A requested shutdown exits zero
only when the application stopped as requested.

Child commands are constructed as argument arrays and execute without a shell.
Child stdout and stderr remain attached to the parent so container runtimes and
host supervisors retain ordinary log collection. Environment values and URLs
that may contain credentials are never included in supervisor logs.

### Health and readiness

FluxFast reserves minimal backend endpoints:

```text
/_fluxfast/healthz
/_fluxfast/readyz
```

Liveness reports only that the FluxFast runtime is alive and initialized.
Readiness reports whether the runtime is able to receive traffic and is not
shutting down. FluxFast-owned external cache or live-broker health may
participate when those implementations provide a bounded health check;
arbitrary application databases and services do not.

Next.js exposes these paths through the same public origin. A successful public
health request therefore proves both that the public process is serving and
that its private backend path is reachable. Responses contain only a status
token and never reveal ports, PIDs, paths, resource identities, cache
namespaces, Redis metadata, or credentials.

### Build and diagnostics boundary

`fluxfast build` invokes the detected local package manager and creates a
production Next.js build. When an application import is supplied, it may also
enforce the existing typed-schema drift checks. `fluxfast start` validates that
the production build already exists; it does not download packages, repair the
project, or build implicitly.

`fluxfast doctor --production` performs read-only deployment diagnostics.
Among other checks, it reports the risk of multiple Uvicorn workers combined
with process-local resource caches or live brokers. Single-worker memory
implementations remain valid. Strict mode may convert production-risk warnings
to a non-zero result, but diagnostics never mutate application configuration.

### Container boundary

The same supervisor and topology run on a host, in Docker, and in rootless
Podman. The reference OCI image contains both runtimes, exposes only the public
Next.js port, runs as a non-root user, and uses the public health path. It does
not require privileged mode or a second application container.

Redis remains an external deployment dependency when distributed cache or live
coherence is configured. Multiple FluxFast application containers may share
Redis while each container continues to expose one public origin and supervise
its own private FastAPI runtime.

### Compatibility and versioning

Production orchestration is additive and does not change the `fluxfast/1`
browser protocol or the `fluxfast-schema/1` developer manifest. Existing
applications may continue running Uvicorn and Next.js manually. Existing
resource, deferred, live, mutation, cache, and generated-type semantics remain
unchanged.

Some production tooling requires matched Python and JavaScript packages when a
feature crosses the supervisor/adapter boundary, such as public health routing.
That packaging constraint does not reinterpret protocol data. Adjacent 0.7 and
0.6 package pairings must continue to validate the existing application
runtime in both directions.

## Consequences

- Deployment platforms see one application, one public port, one lifecycle,
  and one health surface even though FluxFast uses two internal runtimes.
- FastAPI is private by default, reducing accidental backend exposure and
  avoiding a normal cross-origin browser topology.
- FluxFast must correctly behave as PID 1: forward termination, reap its direct
  children, enforce timeouts, and propagate failures.
- Production startup becomes deterministic and observable, but adds a short
  readiness wait before the public process starts.
- Multiple Uvicorn workers remain available without FluxFast owning worker
  implementation. Cross-worker cache and live coherence still require the
  existing Redis implementations when those semantics are needed.
- Docker and Podman use the same OCI definition and runtime command. Platform-
  specific dashboards, TLS, DNS, proxies, and orchestration remain outside the
  framework.
- Release tests must exercise one-port browser traffic, internal-port privacy,
  graceful shutdown, child crashes, multi-worker Redis behavior, clean built
  artifacts, non-root Docker, and rootless Podman.

## Scope exclusions

FluxFast 0.7 does not add a new browser protocol, resource behavior, frontend
adapter, process-manager ecosystem, custom Uvicorn worker model, background job
system, TLS or DNS management, reverse-proxy generator, container registry,
Kubernetes operator, Helm chart, platform-specific deployment automation,
database health framework, or secret manager.

## Rejected alternatives

**Require separate frontend and backend services:** rejected because it makes
the internal two-process implementation a public deployment requirement,
introduces a second browser origin, and breaks continuity with the one-command
development topology.

**Expose FastAPI on `0.0.0.0` by default:** rejected because the standard
adapter reaches FastAPI through private server-to-server transport. A second
public endpoint increases attack surface and operational configuration without
benefiting the normal deployment.

**Start both children concurrently:** rejected because failures and timeouts
become ambiguous. Ordered readiness produces deterministic errors and prevents
Next.js from serving before its backend is reachable.

**Run both runtimes in one process:** rejected because Python/ASGI and
Node.js/Next.js have distinct runtime and lifecycle requirements. Supervision
preserves their supported servers instead of emulating either one.

**Implement a custom worker pool:** rejected because Uvicorn already owns its
worker lifecycle. FluxFast supervises the Uvicorn parent and limits itself to
application-level coordination.

**Use a general-purpose process manager as the required user interface:**
rejected because every deployment would need to reproduce FluxFast-specific
private URL injection, ordered readiness, sibling-failure behavior, and health
routing. External supervisors remain compatible by managing `fluxfast start`.

**Build automatically during `fluxfast start`:** rejected because production
startup must be deterministic, fast, network-independent, and based on a
reviewed artifact. Build and start remain explicit phases.

**Create platform-specific Docker, Podman, aaPanel, Kubernetes, or reverse-
proxy integrations:** rejected because the supervisor's one-port, health-aware
service boundary is sufficient for those platforms to consume without FluxFast
owning their configuration ecosystems.
