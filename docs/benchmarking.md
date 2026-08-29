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

The script reports observed duration and bytes for the initial dashboard,
complete rooms props, and the resource delta. It also asserts that the four
shared values are absent and their loaders executed only once. Results are not
committed as universal claims because wall-clock timings vary by environment.

The Python suite separately proves structured concurrency with 50 ms, 80 ms,
and 100 ms loaders. Browser rendering and mutation latency require separate
browser-level integration tests and are outside this payload microbenchmark.
