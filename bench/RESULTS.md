# effect-smtp vs bun-smtp

Generated 2026-09-14T13:22:23.744Z
Bun 1.3.13, Node 26.8.1, Apple M2 Pro (12 cores)

Methodology: 1 discarded warmup run + 3 timed runs per scenario, median reported. Each server runs as its own OS process: effect-smtp on Node (via nub), bun-smtp on Bun (its required runtime). Both are driven by the same raw-TCP client (`bench/client.ts`) with a no-op DATA handler, `maxSize: 0` (effect-smtp) matched to bun-smtp's `authOptional: true, disableReverseLookup: true`. Higher is better.

| Scenario | effect-smtp (nub / Node) | bun-smtp (Bun) | effect-smtp vs bun-smtp |
| --- | --- | --- | --- |
| Connection throughput | 12903.70 conn/s | 480.93 conn/s | +2583.0% |
| Concurrent transaction throughput | 14081.80 msg/s | 20538.59 msg/s | -31.4% |
| Large payload throughput | 468.50 MB/s | 1286.81 MB/s | -63.6% |

**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a 100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: `setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at concurrency 50 — so the 477 conn/s figure measures that delay, not its accept loop. effect-smtp greets immediately. Read the two throughput rows as the real comparison; the connection row is a protocol-policy difference.

