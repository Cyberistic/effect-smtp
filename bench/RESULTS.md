# effect-smtp vs bun-smtp

Generated 2026-09-15T03:33:09.003Z
Bun 1.3.13, Node 26.8.1, Apple M2 Pro (12 cores)

Methodology: 2 discarded warmup runs + 5 timed runs per scenario, best-of reported. Each server runs as its own OS process and all are driven by the same raw-TCP client (`bench/client.ts`) with a no-op DATA handler, `maxSize: 0` (effect-smtp) matched to bun-smtp's `authOptional: true, disableReverseLookup: true`. The three targets separate the two effects: effect-smtp on Node vs on Bun isolates the runtime (same code), effect-smtp on Bun vs bun-smtp on Bun isolates the implementation. Higher is better.

Best-of-N rather than median: on a shared dev machine other processes steal CPU and depress every run, which a median reports faithfully but which says nothing about the server under test. The peak run is the closest estimate of each server's ceiling. Numbers are still machine-dependent — read a gap under ~15% as noise.

| Scenario | effect-smtp (Node) | effect-smtp (Bun) | bun-smtp (Bun) | smtp-server (Node) | vs smtp-server (Node) |
| --- | --- | --- | --- | --- | --- |
| Connection throughput | 17547.81 conn/s | 9433.26 conn/s | 472.69 conn/s | 476.80 conn/s | +3580.3% |
| Concurrent transaction throughput | 14565.23 msg/s | 14308.35 msg/s | 14578.22 msg/s | 14437.66 msg/s | +0.9% |
| Large payload throughput | 1425.29 MB/s | 1537.21 MB/s | 1150.65 MB/s | 548.52 MB/s | +159.8% |

**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a 100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: `setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at concurrency 50 — so its figure measures that delay, not its accept loop. effect-smtp greets immediately. Read the two throughput rows as the real comparison; the connection row is a protocol-policy difference.

