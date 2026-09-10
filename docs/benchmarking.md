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
the known-version delta, and a fully warm resource response. It asserts the
exact cold, mixed, and warm cache counters, proves that the four shared values
are absent from the delta, and requires every loader to execute only once.

For the deployment behavior measured below, see the [production
guide](production.md) and [container guide](containers.md). Benchmark timings
are observations, while those guides define the supported operational
contract.

Run only the offline schema and TypeScript toolchain benchmark with:

```bash
pnpm benchmark:codegen
```

Run the core validation-plan runtime, retained-memory trend, and production
bundle scenarios with:

```bash
pnpm benchmark:validation
pnpm benchmark:memory
pnpm benchmark:bundle
```

The memory scenario requires Node's explicit garbage-collection hook, which the
package command enables. It samples repeated 100-cycle navigation, deferred,
mutation, and live-reconnect workloads plus 10,000-entry ResourceStore and
validation workloads. Heap trends are observations; bounded store, connection,
listener, and result state are correctness gates.

The bundle scenario performs five real Next.js production builds. It uses a
temporary project inside the repository boundary because Turbopack rejects
package symlinks that leave its detected filesystem root. The temporary build
trees are removed whether the benchmark passes or fails.

For a same-harness source comparison, build the other checkout first and point
the memory, bundle, or production script at it with
`FLUXFAST_BENCHMARK_REPOSITORY_ROOT`. The compared checkout must use the same
Node, Python, Next.js, and React versions. This override exists for controlled
comparisons and does not change the ordinary `pnpm benchmark` path.

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
exports their Pydantic schemas, and consumes the manifests with the built
`@fluxfast/next` package. It covers ten fixed workloads:

| Workload | Explicit contracts | Resources | Page routes | JSON mutations | Purpose |
| --- | ---: | ---: | ---: | ---: | --- |
| `contracts-10` | 10 | 0 | 0 | 0 | Small schema/2 baseline |
| `contracts-100` | 100 | 0 | 0 | 0 | Medium contract scaling |
| `contracts-500` | 500 | 0 | 0 | 0 | Large contract scaling |
| `contracts-1000` | 1,000 | 0 | 0 | 0 | Manifest-boundary scaling |
| `resources-10` | 0 | 10 | 0 | 0 | Small typed resource baseline |
| `resources-100` | 0 | 100 | 0 | 0 | Medium resource scaling |
| `resources-500` | 0 | 500 | 0 | 0 | Large resource scaling |
| `large-nested` | 0 | 10 | 0 | 0 | 24 repeated nested model levels |
| `many-routes` | 0 | 10 | 500 | 0 | Route-helper scaling |
| `many-mutations` | 0 | 10 | 0 | 500 | Mutation-helper scaling |

For each workload it measures Python manifest generation, Node manifest
parsing, type compilation, validator compilation, a real TypeScript compiler
pass over every generated contract artifact, `fluxfast doctor`, and
`fluxfast generate --check`.
Python export records the first export separately and then measures repeated
exports of the same application. Every Node stage gets one untimed warm-up
before the measured samples. Direct parsing and generation isolate codegen
CPU. The TypeScript number includes starting a fresh `tsc` process, while the
CLI measurements include project detection, file reads, and artifact
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

On 2026-09-03, Linux WSL2 x86_64 with Python 3.13.14 and Node 24.19.0
produced:

| Workload | Manifest | Python export | Parse | Types | Validators | `tsc` | Doctor | Generate check |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 contracts | 2.7 KiB | 3.233 ms | 0.201 ms | 0.498 ms | 0.674 ms | 138.785 ms | 3.558 ms | 2.259 ms |
| 100 contracts | 25.8 KiB | 37.437 ms | 1.345 ms | 2.286 ms | 2.653 ms | 140.026 ms | 18.223 ms | 8.817 ms |
| 500 contracts | 128.1 KiB | 159.528 ms | 5.622 ms | 9.937 ms | 13.545 ms | 224.690 ms | 58.274 ms | 36.334 ms |
| 1,000 contracts | 256.0 KiB | 322.587 ms | 15.095 ms | 18.460 ms | 21.522 ms | 360.761 ms | 113.706 ms | 70.048 ms |
| 10 resources | 5.2 KiB | 6.855 ms | 0.315 ms | 0.712 ms | 0.939 ms | 138.304 ms | 5.374 ms | 2.818 ms |
| 100 resources | 50.9 KiB | 63.467 ms | 2.791 ms | 5.261 ms | 7.551 ms | 173.523 ms | 35.875 ms | 21.312 ms |
| 500 resources | 253.6 KiB | 319.637 ms | 15.912 ms | 26.914 ms | 40.623 ms | 398.485 ms | 182.084 ms | 105.861 ms |
| Large nested schema | 81.0 KiB | 159.057 ms | 4.043 ms | 10.922 ms | 10.966 ms | 202.814 ms | 63.898 ms | 36.873 ms |
| 500 routes | 147.7 KiB | 465.437 ms | 9.616 ms | 8.865 ms | 9.356 ms | 164.565 ms | 81.941 ms | 50.714 ms |
| 500 mutations | 255.1 KiB | 375.660 ms | 13.179 ms | 24.782 ms | 30.225 ms | 379.850 ms | 146.112 ms | 97.525 ms |

All correctness checks passed. The largest observed costs were Python-side
FastAPI/Pydantic route and mutation schema extraction; direct Node parsing and
generation remained a smaller portion of the measured toolchain. `doctor` and
`generate --check` intentionally trade additional project and filesystem work
for end-to-end validation. Run the benchmark on the target development machine
before making local performance decisions. The table reports medians from five
samples; the benchmark output also retains first-export and p95 values.

## Validation-Plan Runtime Scenario

The runtime benchmark constructs framework-neutral validators directly from
representative core validation plans, then
measures valid and invalid values for a 24-level nested object, a 10,000-object
array, and a 16-node recursive contract. The recursive plan uses the same local
JSON Pointer reference form emitted by the schema compiler. This isolates the
evaluator hot path; the separate code-generation benchmark measures compilation.
Each measured sample performs 25 validations after one untimed correctness
warm-up. The large-array plans use an explicit 500,000-operation budget; all
other limits remain at their production defaults.

On the same host on 2026-09-04, five samples produced:

| Workload | Median per validation | p95 per validation |
| --- | ---: | ---: |
| Nested object, valid | 0.068 ms | 0.235 ms |
| Nested object, invalid leaf | 0.055 ms | 0.080 ms |
| 10,000 objects, valid | 13.020 ms | 14.221 ms |
| 10,000 objects, invalid tail | 13.191 ms | 13.899 ms |
| Recursive value, valid | 0.046 ms | 0.123 ms |
| Recursive value, invalid tail | 0.042 ms | 0.050 ms |

Correctness is the gate: valid inputs must be accepted, while invalid leaf and
tail values must report their exact nested paths. Timings have no threshold.
Validation is synchronous and bounded, so a valid large collection necessarily
traverses every item.

## Production Bundle Scenario

The bundle benchmark generates 100 distinct contracts and makes five clean
Next.js production builds: a minimal Core consumer, a minimal Next consumer, a
realistic validator-free consumer, that same consumer with one validator, and a
realistic validators/live/forms consumer with ten validators. Unique field
markers prove exactly which static validation plans survive tree-shaking.
Separate validation-runtime string markers prove that validator-free FluxFast
usage does not retain the runtime; byte totals alone cannot prove either
property.

On the same host on 2026-09-04 with Next.js 16.3.3:

| Consumer | `/` first-load JS | All client chunks | Delta from no import | Validator chunks | Retained plans | Runtime markers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No validator import | 448.6 KiB | 558.6 KiB | 0 B | 0 B | 0 | 0 |
| One validator | 473.2 KiB | 583.2 KiB | +24.6 KiB | 30.6 KiB | 1 | 2 |
| Ten validators | 474.6 KiB | 584.5 KiB | +25.9 KiB | 32.0 KiB | 10 | 2 |

Before the purity fix, inspecting a production page chunk showed every
generated `createValidator(...)` initializer retained when only one validator
was imported. A subsequent audit also found that the CommonJS-only package
entry retained the validation runtime for ordinary Core and Next imports.
FluxFast now publishes a tree-shakeable ESM import condition while preserving
the CommonJS `require()` condition. Generated calls carry a bundler-recognized
purity annotation, and the two marker gates prove both that unused plans
disappear and that the runtime is opt-in. The observed first-validator cost is
about 24.6 KiB of first-load JavaScript; additional plans add incremental bytes.
Aggregate `.next` totals also contain framework chunks, so they are comparison
data rather than package-size guarantees.

## v0.9 Freeze Baseline Against v0.8.1

The v0.9 freeze comparison used the `v0.8.1` tag and the v0.9 candidate based on
`ed313bc8cca7c9276761605d763ecb671319cb82`. Both checkouts ran the current
benchmark harness on 2026-09-10 on Linux WSL2 x86_64 with an AMD Ryzen 5 3600,
Python 3.13.14, Node 24.19.0, Next.js 16.3.4, and React 19.2.8. Each comparison
ran sequentially on the same host. Values below are medians; timings remain
observations rather than release promises.

The existing request and synchronization hot paths stayed within 10%:

| Existing hot path | v0.8.1 | v0.9 candidate | Change |
| --- | ---: | ---: | ---: |
| Initial dashboard, 6 cold misses | 5.15 ms | 5.18 ms | +0.6% |
| Complete rooms props | 2.07 ms | 2.09 ms | +1.0% |
| Known-version rooms delta, 4 hits / 2 misses | 6.07 ms | 6.29 ms | +3.6% |
| Warm rooms response, 6 hits / 0 misses | 2.97 ms | 3.01 ms | +1.3% |
| Deferred initial response | 12.64 ms | 12.52 ms | -0.9% |
| Deferred settlement | 515.97 ms | 515.79 ms | -0.0% |
| Live publish to receive | 0.072 ms | 0.073 ms | +1.4% |
| Live invalidation to canonical refresh | 2.806 ms | 2.769 ms | -1.3% |
| Redis cold fan-out, 1/2/4/8 workers | 56.506/57.153/58.868/63.439 ms | 56.510/57.417/60.256/61.651 ms | -2.8% to +2.4% |
| Redis warm hit, 1/2/4/8 workers | 136.004/94.850/58.200/58.269 ms | 140.231/98.039/60.120/62.464 ms | +3.1% to +7.2% |

All payloads and correctness outcomes matched. The 86,119-byte complete rooms
response became a 64,314-byte delta, a 25.3% reduction, while all four known
shared resources were omitted. Redis retained exact cross-client values,
bounded cold fan-out behavior, one loader execution during every warm phase,
and known-version omission at every worker count.

The five-sample developer-tool and validator comparison used the same manifests
and generated output:

| Workload | Operation | v0.8.1 | v0.9 candidate | Change |
| --- | --- | ---: | ---: | ---: |
| 1,000 contracts | Python schema export | 271.669 ms | 274.845 ms | +1.2% |
| 1,000 contracts | Manifest parse | 13.698 ms | 13.227 ms | -3.4% |
| 1,000 contracts | Type generation | 14.836 ms | 16.368 ms | +10.3% |
| 1,000 contracts | Validator generation | 17.267 ms | 18.167 ms | +5.2% |
| 500 resources | TypeScript compile | 351.601 ms | 346.327 ms | -1.5% |
| 500 resources | `fluxfast doctor` | 156.038 ms | 156.759 ms | +0.5% |
| 500 resources | `generate --check` | 91.546 ms | 100.984 ms | +10.3% |
| 10,000-object valid array | Validator runtime | 11.326 ms | 11.637 ms | +2.7% |
| 10,000-object invalid-tail array | Validator runtime | 11.410 ms | 11.303 ms | -0.9% |

The two 10.3% tool observations were investigated. Neither reproduced above
10% in the independent three-sample pass: type generation was +7.4%, while
`generate --check` was -0.9%. The underlying compiler output remained
byte-identical and the compiler implementations did not change. They are
recorded as host and process noise in millisecond-scale developer tooling, not
as repeatable regressions in an application hot path.

Using the identical five-build harness against each checkout produced the same
reported JavaScript size profile:

| Consumer | First-load JS | All client chunks | Retained plans | Runtime markers |
| --- | ---: | ---: | ---: | ---: |
| Minimal Core | 447.9 KiB (458,694 B) | 557.9 KiB (571,288 B) | 0 | 0 |
| Minimal Next | 448.6 KiB (459,341 B) | 558.5 KiB (571,935 B) | 0 | 0 |
| No validators | 453.0 KiB (463,860 B) | 562.9 KiB (576,454 B) | 0 | 0 |
| One validator | 477.5 KiB (488,994 B) | 587.5 KiB (601,588 B) | 1 | 2 |
| Validators/live/forms | 478.9 KiB (490,367 B) | 588.8 KiB (602,961 B) | 10 | 2 |

The one-validator cost remained 24.5 KiB over the realistic validator-free
consumer, and ten validators cost 25.9 KiB. Every validator-free build omitted
all plans and validation-runtime markers, preserving the tree-shaking contract.

The repeated retained-heap observation used five samples after one warm-up.
Both versions completed each batch with the same hard bounds: page cache at or
below 8 entries, ResourceStore at or below 32 navigation resources or 256 large
store entries, one converged deferred or mutation resource, and zero live
connections and network listeners after teardown. Per-sample heap trends were
within 0.2 KiB for navigation, deferred loads, mutation cycles, live reconnects,
and the large ResourceStore. Validation-call trends were 10.1 KiB for v0.8.1
and 8.6 KiB for the candidate. V8 heap values are diagnostic and are not exact
byte thresholds; the bounded state assertions are the CI gate.

The three-sample production repeat showed no startup regression:

| Workers | v0.8.1 FastAPI start / public ready | v0.9 FastAPI start / public ready |
| ---: | ---: | ---: |
| 1 | 391.710 / 1,545.145 ms | 360.649 / 1,517.695 ms |
| 2 | 356.695 / 1,603.197 ms | 357.491 / 1,612.745 ms |
| 4 | 357.679 / 1,676.619 ms | 358.821 / 1,715.014 ms |
| 8 | 358.368 / 1,781.522 ms | 357.258 / 1,824.361 ms |

Every lifecycle used the requested worker count, exposed only the public port,
kept FastAPI on loopback, reached readiness in causal order, shut down cleanly,
and left no child process or listening socket. An earlier two-sample pass
showed a greater than 10% difference in process-discovery timing at higher
worker counts; the three-sample repeat did not reproduce it, so it was treated
as scheduler noise rather than an accepted regression.

The freeze policy is therefore: correctness, payload identity, resource bounds,
and tree-shaking checks fail hard; host timing and heap observations do not.
Any repeatable regression above 10% in a meaningful existing runtime hot path
must be investigated and either fixed or recorded with its accepted tradeoff.

## v0.7 Runtime Regression Comparison

The v0.8 work adds code generation and opt-in validators; it must not make
validators run on resource responses. A same-machine comparison used the exact
same current benchmark harness against the `v0.7.0` Python source and this
branch. It used ten fresh applications for navigation, five deferred samples,
ten live-update samples, and five Redis payload samples with 32 warm HTTP
requests per worker count.

| Existing hot path | v0.7.0 | v0.8 implementation | Change |
| --- | ---: | ---: | ---: |
| Initial dashboard | 5.72 ms | 6.22 ms | +8.7% |
| Complete-props response | 2.37 ms | 2.34 ms | -1.3% |
| Known-resource delta | 7.06 ms | 7.05 ms | -0.1% |
| Blocking deferred control | 504.84 ms | 504.80 ms | -0.0% |
| Deferred initial response | 13.34 ms | 13.06 ms | -2.1% |
| Deferred follow-up | 504.03 ms | 503.90 ms | -0.0% |
| Live publish to receive | 0.086 ms | 0.094 ms | +9.3% |
| Live invalidation to refresh | 3.566 ms | 3.824 ms | +7.2% |
| Redis cold fan-out, 1/2/4/8 workers | 57.481/57.357/60.190/62.251 ms | 57.568/57.227/59.229/63.628 ms | -1.6% to +2.2% |
| Redis warm hit, 1/2/4/8 workers | 77.004/47.058/33.614/25.697 ms | 69.962/38.328/23.030/25.025 ms | equal or faster |

All correctness checks and payload sizes matched. No existing route-level hot
path showed a repeatable regression over 10%. Some sub-millisecond setup and
individual cache-operation measurements moved by larger percentages between
runs, but the v0.7-to-current diff does not modify the live or cache runtime
implementations; those changes are measurement noise, not evidence that
validators entered the response hot path. There are deliberately no hard
millisecond CI gates.

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
