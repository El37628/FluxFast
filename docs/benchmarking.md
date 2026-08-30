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
complete-props endpoint and the FluxFast routes. Run it on the target machine:

```bash
pnpm benchmark
```

The command runs all controlled scenarios. The cross-page script reports
observed duration and bytes for the initial dashboard, complete rooms props,
and the resource delta. It also asserts that the four shared values are absent
and their loaders executed only once.

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
| 1 connection | 0.331 ms |
| 10 connections | 1.006 ms |
| 100 connections | 5.286 ms |
| 500 connections | 30.281 ms |
| Publish to receive | 0.083 ms median, 0.138 ms p95 |
| Invalidation to canonical refresh | 0.979 ms median, 1.422 ms p95 |
| 10,000-event slow-client flood | 16/64 pending, 156 overflows |
| Flood memory | 140,005 peak traced bytes, 568 retained traced bytes |
| 500 repeated connections | 50.851 ms, 0 active afterward |

The queue deliberately trades intermediate event delivery for a bounded resync
signal when a client falls behind. That is the intended safety behavior:
canonical refresh restores current state without letting memory grow with the
number of published events. Traced-memory figures cover this controlled Python
workload, not total process RSS. Run `pnpm benchmark` on the deployment target
for locally meaningful timings.
