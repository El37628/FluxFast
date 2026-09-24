# v1.0 performance follow-up measurements

These measurements follow the full forward/reverse comparisons in
`forward/comparison.json` and `reverse/comparison.json`. They use the same
WSL2/Ryzen 5 3600 host, dependency versions, and disposable Redis 8.10.1
instance.

## Request/cache, 100 samples

The first reverse comparison showed 11–14% higher request/cache medians even
though the forward comparison was slightly faster. To investigate, the same
benchmark and matched environments were alternated three times, using 100 fresh
applications per source each time:

| Order | Source | Initial dashboard | Resource delta | Warm response |
| --- | --- | ---: | ---: | ---: |
| Candidate then baseline | Candidate | 5.95 ms | 7.25 ms | 3.57 ms |
| Candidate then baseline | v0.9.0 | 5.91 ms | 7.19 ms | 3.51 ms |
| Baseline then candidate | v0.9.0 | 5.82 ms | 7.02 ms | 3.50 ms |
| Baseline then candidate | Candidate | 5.80 ms | 7.04 ms | 3.47 ms |
| Candidate then baseline | Candidate | 5.87 ms | 7.05 ms | 3.45 ms |
| Candidate then baseline | v0.9.0 | 5.81 ms | 7.02 ms | 3.46 ms |

Every run passed exact payload, omission, cache-counter, and loader-count
checks. The largest difference across these paired medians was 1.7%, so the
single reverse-pass increase did not reproduce as a candidate regression.

## Redis, 50 samples

Run `benchmarks/scripts/benchmark_redis_cache.py --samples 50` once with
`FLUXFAST_BENCHMARK_REPOSITORY_ROOT` set to the v0.9.0 checkout and once to the
candidate checkout. The matching checkout's `python/fluxfast/src` was first in
`PYTHONPATH`; both used the same Python 3.13.14 environment and Redis URL.
Namespaces are random per run.

| Payload | v0.9.0 Redis set | Candidate Redis set | v0.9.0 cross-client read | Candidate cross-client read |
| --- | ---: | ---: | ---: | ---: |
| 1 KiB | 0.444 ms | 0.436 ms | 0.403 ms | 0.400 ms |
| 10 KiB | 0.482 ms | 0.471 ms | 0.433 ms | 0.414 ms |
| 100 KiB | 0.874 ms | 0.861 ms | 0.566 ms | 0.548 ms |
| 1 MiB | 5.723 ms | 5.783 ms | 2.860 ms | 2.872 ms |

All figures are medians. Both runs passed payload equality, tag invalidation,
64-request warm traffic at each 1/2/4/8-worker topology, one warm loader
execution, and known-version omission checks. The 1 MiB read difference is
0.4%; the initial 10-sample observation above 10% did not reproduce.

## Memory, 10 samples

Run `node --expose-gc benchmarks/scripts/benchmark_memory.mjs --samples 10
--cycles 100` once per checkout, selecting each checkout with
`FLUXFAST_BENCHMARK_REPOSITORY_ROOT`. Both used Node 24.19.0 and their
respective just-built `packages/core/dist`.

The candidate passed. In the mixed long-lived router, it retained 16 state
snapshots throughout, with 10 resource records. Epoch history reached its
1,024-entry cap at sample 2 (300 cycles), then remained at that cap; heap
settled around 6.10 MiB at sample 6 and stayed there through sample 10. At
1,100 cycles it retained +280.1 KiB, with a +23.3 KiB per-sample trend.

The v0.9.0 run completed every preceding scenario and failed only the
state-snapshot bound. State snapshots grew from 216 to 1,116 and epochs from
800 to 4,400 over 200 to 1,100 cycles. At 1,100 cycles it retained +708.4 KiB,
with a +69.8 KiB per-sample trend. This is the known state-only metadata defect
already narrowly classified in the full comparison runner.
