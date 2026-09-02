# FluxFast Benchmarking & Performance Methodology

## Signature Scenario: Cross-Page Resource Reuse

In traditional server-driven architectures, transitioning from `/dashboard` to `/rooms` resends all shared page props (`auth`, `hotel`, `permissions`, `settings`) on every navigation.

FluxFast eliminates this redundancy:

```text
/dashboard (6 resources)
    ↓  [client sends X-FluxFast-Known header]
/rooms (4 shared + 2 new)
    ↓
Delta Response: only `room_types` and `rooms` transferred!
```

The controlled fixture uses the same FastAPI process and synthetic dataset for a
complete-props endpoint and the FluxFast routes. With Redis already running,
run it on the target machine:

```bash
pnpm benchmark
```

The distributed-cache scenario uses
`FLUXFAST_BENCHMARK_REDIS_URL` when set and otherwise connects to
`redis://127.0.0.1:6379/15`. It uses an isolated random namespace and removes
its keys after every run. The manually dispatched `Benchmark` workflow starts
Redis and retains each script's output in the `controlled-benchmark` artifact,
so results can be compared over time without turning host-dependent timings
into release gates. The compatibility matrix, rather than this benchmark,
establishes the [supported Redis server range](distributed-cache.md#supported-redis-versions).

The command runs all controlled scenarios. The cross-page script reports
observed duration and bytes for the initial dashboard, complete rooms props,
and the resource delta. It also asserts that the four shared values are absent
and their loaders executed only once.

For the deployment behavior measured below, see the [production
guide](production.md) and [container guide](containers.md). Benchmark timings
are observations, while those guides define the supported operational
contract.

Run only the offline schema and TypeScript toolchain benchmark with:

```bash
pnpm benchmark:codegen
```

Run only the production supervisor benchmark with:

```bash
pnpm benchmark:production
```

The production benchmark builds the browser fixture once, then performs three
complete start/readiness/SIGTERM cycles at each of 1, 2, 4, and 8 FastAPI
workers. It currently requires Linux `/proc` so it can prove process ancestry,
socket bindings, and cleanup without adding a monitoring dependency. Use
`--samples N` after `--` to change the sample count; at least two samples are
required because repeated start/stop cleanup is a correctness gate. Pass
`--skip-build` only when the fixture already has a current production build.

Container observations are separate because they require a container engine:

```bash
pnpm benchmark:container
FLUXFAST_CONTAINER_ENGINE=podman pnpm benchmark:container
```

Docker is the default. The same harness accepts a local Podman CLI. It removes
its temporary container and image after the run.

Pass `--samples N` after `--` to select the measured sample count, for example
`pnpm benchmark:codegen -- --samples 1` for a quick correctness run.

## Production Lifecycle Scenario

The lifecycle benchmark executes the real `fluxfast start` command and the
repository's built Next.js fixture. Each sample records cumulative elapsed time
from supervisor launch to:

- the FastAPI child process appearing in the supervisor's `/proc` tree;
- the supervisor reporting FastAPI readiness;
- the Next.js production process appearing in that same tree; and
- an exact `{"status":"ready"}` response from the public origin.

It then measures SIGTERM through clean supervisor exit. Timings are
observational: pull requests do not fail because a phase takes a particular
number of milliseconds. They do fail if the phase order or runtime contract is
wrong.

Every 1/2/4/8-worker sample proves that Uvicorn reported exactly the requested
server-process count and that those PIDs belong to the supervisor tree. It also
requires one externally bound public socket, a FastAPI socket bound only to
`127.0.0.1`, minimal health and readiness payloads, exit status zero, closed
sockets, and no surviving captured PID after shutdown. Running at least two
samples per topology catches repeated start/stop leaks. Redis coherence for the
same worker-count matrix remains a separate controlled workload in the
[distributed resource cache scenario](#distributed-resource-cache-scenario);
CI executes both correctness paths.

### Observed Production Lifecycle Reference Run

The initial v0.7 baseline below used two complete samples per worker count on
2026-09-02, on Linux WSL2 x86_64 with an AMD Ryzen 5 3600, Python 3.13.14,
Node 24.19.0, and Next.js 16.3.3. Values are medians except peak descendants.

| Workers | FastAPI process start | FastAPI ready | Next.js process start | Public ready | SIGTERM cleanup | Peak descendants |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 436.567 ms | 948.693 ms | 968.072 ms | 1,775.738 ms | 326.854 ms | 4 |
| 2 | 410.644 ms | 1,084.026 ms | 1,094.568 ms | 1,869.292 ms | 483.448 ms | 7 |
| 4 | 431.777 ms | 1,154.523 ms | 1,163.074 ms | 1,919.448 ms | 631.325 ms | 9 |
| 8 | 427.790 ms | 1,349.785 ms | 1,359.361 ms | 2,165.335 ms | 443.472 ms | 13 |

All correctness gates passed across eight full lifecycles. The result shows the
expected tradeoff on this machine: more FastAPI workers add startup and process
work, while preserving the same public boundary and clean lifecycle. The
shutdown samples are too few and host-sensitive to rank worker counts; rerun
the workload on the deployment target instead of treating small differences as
a guarantee.

## Production Container Scenario

The container benchmark builds the repository's production `Dockerfile`, reads
the engine-reported image size, starts the hardened image with one random host
mapping, waits for public readiness, and samples every application process from
the container's `/proc`. It reports summed per-process `VmRSS` and process
count, then measures a clean container stop. Summed `VmRSS` can count shared
pages more than once and is not equivalent to cgroup working-set memory; its
purpose is a repeatable process-level observation.

The initial Docker and rootless Podman baselines on the same 2026-09-02 host
produced:

| Measurement | Docker | Rootless Podman |
| --- | ---: | ---: |
| Engine-reported image size | 129,917,451 B (123.9 MiB) | 381,725,952 B (364.0 MiB) |
| Container run to public readiness | 2,134.774 ms | 2,181.702 ms |
| Idle application processes | 5 | 5 |
| Summed idle process `VmRSS` | 299,072 KiB (292.1 MiB) | 299,896 KiB (292.9 MiB) |
| Container stop | 608.772 ms | 747.964 ms |

The correctness gates confirmed only `3000/tcp` was exposed and published,
health/readiness returned their exact minimal bodies, process metrics were
captured only after readiness, and stopping the container cleanly terminated
PID 1 and its children. The image intentionally includes both Python/FastAPI
and Node/Next.js; the additional runtime footprint buys a single deployable
application boundary. Image size is the local engine's content size, not a
registry-compressed transfer size. Docker and Podman account for local image
content differently, so their size values are baselines within each engine and
should not be compared as if they used the same storage metric.

## Schema Code Generation Scenario

The code-generation benchmark builds real FastAPI and FluxFast applications,
exports their Pydantic serialization schemas, and consumes the manifests with
the built `@fluxfast/next` package. It covers six fixed workloads:

| Workload | Resources | Page routes | JSON mutations | Purpose |
| --- | ---: | ---: | ---: | --- |
| `resources-10` | 10 | 0 | 0 | Small typed baseline |
| `resources-100` | 100 | 0 | 0 | Medium resource scaling |
| `resources-500` | 500 | 0 | 0 | Large resource scaling |
| `large-nested` | 10 | 0 | 0 | 24 repeated nested model levels |
| `many-routes` | 10 | 500 | 0 | Route-helper scaling |
| `many-mutations` | 10 | 0 | 500 | Mutation-helper scaling |

For each workload it measures Python schema export, Node manifest parsing,
TypeScript generation, `fluxfast doctor`, and `fluxfast generate --check`.
Python export records the first export separately and then measures repeated
exports of the same application. Every Node stage gets one untimed warm-up
before the measured samples. Direct parsing and generation isolate codegen CPU;
the CLI measurements also include project detection, file reads, and artifact
comparison.

Timing output is observational and has no pass/fail threshold. Correctness
checks require deterministic manifests, matching counts and fingerprints,
byte-stable generated output, no page or mutation handler execution, and clean
results from both CLI checks. Pull requests execute every workload with one
sample to prevent benchmark drift. The manually dispatched `Benchmark`
workflow uses five samples and uploads the complete output as `codegen.txt`.

### Observed Code-Generation Reference Run

The controlled reference table below records medians from five measured
samples. It is a baseline for comparing the same workload, not a latency
guarantee and not a release gate.

On 2026-09-01, Linux WSL2 x86_64 with Python 3.13.14 and Node 24.19.0
produced:

| Workload | Manifest | First Python export | Python export | Node parse | TypeScript generation | Doctor | Generate check |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 resources | 5.2 KiB | 6.111 ms | 4.134 ms | 0.230 ms | 0.817 ms | 2.966 ms | 1.605 ms |
| 100 resources | 50.9 KiB | 40.900 ms | 39.586 ms | 1.506 ms | 5.971 ms | 13.183 ms | 7.522 ms |
| 500 resources | 253.6 KiB | 210.104 ms | 200.440 ms | 7.076 ms | 22.541 ms | 53.968 ms | 28.435 ms |
| Large nested schema | 81.0 KiB | 105.220 ms | 107.456 ms | 2.072 ms | 9.260 ms | 23.461 ms | 10.857 ms |
| 500 routes | 147.7 KiB | 325.666 ms | 334.061 ms | 3.656 ms | 12.934 ms | 25.526 ms | 19.521 ms |
| 500 mutations | 255.1 KiB | 274.170 ms | 275.546 ms | 5.599 ms | 16.422 ms | 29.975 ms | 21.653 ms |

All correctness checks passed. The largest observed costs were Python-side
FastAPI/Pydantic route and mutation schema extraction; direct Node parsing and
generation remained a smaller portion of the measured toolchain. `doctor` and
`generate --check` intentionally trade additional project and filesystem work
for end-to-end validation. Run the benchmark on the target development machine
before making local performance decisions.

## Deferred Resource Scenario

The deferred benchmark uses three uncacheable async resources with fixed loader
delays: `fast=10 ms`, `medium=100 ms`, and `slow=500 ms`. Every sample measures:

- a legacy blocking request with all three immediate resources;
- a capability-enabled blocking request, which controls for overhead on
  ordinary `defer=False` resources;
- a deferred initial request that resolves only `fast`; and
- one resource-only follow-up that resolves `medium` and `slow` concurrently.

It reports response latency, payload bytes, resources returned, pending keys,
cache hits/misses, and loader counts. Correctness checks require the deferred
initial response to run only the fast loader, the follow-up to run the two slow
loaders, and both blocking requests to keep every resource immediate. CI uses
those relative sequencing checks and does not enforce machine-dependent timing
thresholds.

### Observed Reference Run

On 2026-08-30, three samples on Linux WSL2 x86_64 with Python 3.13.14 produced:

| Measurement | Median latency | Payload | Resources | Pending |
| --- | ---: | ---: | ---: | ---: |
| Blocking baseline initial | 504.00 ms | 1,335 B | 3 | 0 |
| Blocking capable initial | 503.93 ms | 1,375 B | 3 | 0 |
| Deferred initial | 12.93 ms | 542 B | 1 | 2 |
| Deferred follow-up | 503.67 ms | 1,011 B | 2 | 0 |
| Deferred settlement (two requests) | 516.63 ms | 1,553 B total | 3 | 0 |

The observed capability-only blocking delta was -0.07 ms, which is measurement
noise rather than a universal performance claim. Deferral made the initial
envelope available before the 100/500 ms loaders ran, while total settlement
was 12.63 ms slower and transferred 218 additional bytes because it used two
protocol envelopes. All cache-hit counters were zero by design, loader counts
matched the expected sequence, and the benchmark's correctness checks passed.

Wall-clock results vary by machine. Run `pnpm benchmark` on the target system
and use its output instead of treating this reference run as a guarantee.
Browser rendering, retry, navigation-race, and mutation behavior are covered by
the separate Playwright integration suite.

## Live Resource Scenario

The live benchmark exercises the in-process `MemoryLiveBroker` and an actual
FluxFast resource-only request. It measures connection creation at 1, 10, 100,
and 500 subscribers, publish-to-receive latency, and invalidation-to-canonical-
refresh convergence. It then floods one subscriber without consuming from it
and repeatedly connects and disconnects subscribers.

Timing is diagnostic output, not a CI threshold. The correctness gates require:

- the canonical resource-only response to contain each newly invalidated value;
- the slow subscriber's pending count to remain at or below its configured
  queue size;
- queue overflow recovery to occur during the flood; and
- pending events and active subscribers to return to zero after cleanup.

### Observed Live Reference Run

On 2026-08-31, the initial controlled baseline on Linux WSL2 x86_64, an AMD
Ryzen 5 3600, and Python 3.13.14 produced:

| Measurement | Result |
| --- | ---: |
| 1 connection | 0.133 ms |
| 10 connections | 0.509 ms |
| 100 connections | 5.411 ms |
| 500 connections | 27.909 ms |
| Publish to receive | 0.082 ms median, 0.118 ms p95 |
| Invalidation to canonical refresh | 3.303 ms median, 3.812 ms p95 |
| 10,000-event slow-client flood | 16/64 pending, 156 overflows |
| Flood memory | 140,005 peak traced bytes, 568 retained traced bytes |
| 500 repeated connections | 50.572 ms, 0 active afterward |

The queue deliberately trades intermediate event delivery for a bounded resync
signal when a client falls behind. That is the intended safety behavior:
canonical refresh restores current state without letting memory grow with the
number of published events. Traced-memory figures cover this controlled Python
workload, not total process RSS. Run `pnpm benchmark` on the deployment target
for locally meaningful timings.

## Distributed Resource Cache Scenario

The Redis benchmark compares `MemoryResourceCache` with
`RedisResourceCache` for exact 1 KiB, 10 KiB, 100 KiB, and 1 MiB string
payloads. Redis reads come from a second cache client, proving the serialized
entry crosses a client boundary. Each payload round-trip checks its value,
version, and tags. A separate workload fills and invalidates 100 entries under
one tag, then verifies that every key is absent.

The benchmark configures a 2 MiB value limit so the 1 MiB source string plus
its serialized envelope fits. This does not change the production default
guard; the reported serialized byte count is the value relevant to that guard.

The process-level workload starts 1, 2, 4, and 8 independent Uvicorn workers.
For each worker count it records:

- simultaneous cold-fan-out time and loader executions;
- 64 concurrent warm-cache responses, throughput, and request latency;
- process-local Redis cache reads and writes aggregated across workers; and
- one known-version request per worker, all of which must omit the resource.

The cold loader sleeps for 50 ms so simultaneous misses overlap. FluxFast does
not provide a distributed single-flight lease, so duplicate cold loads are
expected and reported. The warm phase first seeds Redis and then requires the
global loader count to remain exactly one regardless of worker count.

### Observed Distributed-Cache Reference Run

On 2026-08-31, five payload samples and 64 warm requests per worker-count run
on Linux WSL2 x86_64, an AMD Ryzen 5 3600, Python 3.13.14, and Redis 8.10.1
produced:

| Payload | Serialized | Memory set/get median | Redis set/cross-client get median |
| --- | ---: | ---: | ---: |
| 1 KiB | 1,097 B | 0.028 / 0.012 ms | 0.250 / 0.243 ms |
| 10 KiB | 10,314 B | 0.023 / 0.012 ms | 0.317 / 0.261 ms |
| 100 KiB | 102,475 B | 0.027 / 0.012 ms | 0.541 / 0.428 ms |
| 1 MiB | 1,048,652 B | 0.044 / 0.013 ms | 5.158 / 2.451 ms |

Invalidating 100 tagged entries took 1.075 ms median and 1.215 ms p95.

| Workers | Cold loaders | Warm throughput | Warm hit latency median/p95 | Redis reads/writes | Known omissions |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 395.5 req/s | 141.269 / 152.432 ms | 66 / 1 | 1/1 |
| 2 | 2 | 541.9 req/s | 105.426 / 111.027 ms | 67 / 1 | 2/2 |
| 4 | 4 | 726.7 req/s | 70.744 / 82.285 ms | 69 / 1 | 4/4 |
| 8 | 8 | 812.7 req/s | 57.885 / 67.877 ms | 73 / 1 | 8/8 |

Warm latency includes queueing from the deliberately concurrent 64-request
batch; it is not single-request Redis latency. Every warm run used one loader
and one Redis write. Redis adds serialization and network work compared with
the process-local cache, in exchange for coherence across processes. These
numbers are a repeatable reference workload, not a performance guarantee or a
millisecond threshold.
