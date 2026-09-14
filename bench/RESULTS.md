# effect-smtp vs bun-smtp

Generated 2026-09-14T13:17:48.026Z
Bun 1.3.13, Node 26.8.1, Apple M2 Pro (12 cores)

Methodology: 1 discarded warmup run + 3 timed runs per scenario, median reported. Each server runs as its own OS process: effect-smtp on Node (via nub), bun-smtp on Bun (its required runtime). Both are driven by the same raw-TCP client (`bench/client.ts`) with a no-op DATA handler, `maxSize: 0` (effect-smtp) matched to bun-smtp's `authOptional: true, disableReverseLookup: true`. Higher is better.

| Scenario | effect-smtp (nub / Node) | bun-smtp (Bun) | effect-smtp vs bun-smtp |
| --- | --- | --- | --- |
| Connection throughput | 14682.50 conn/s | 478.78 conn/s | +2966.6% |
| Concurrent transaction throughput | 15982.98 msg/s | 19835.12 msg/s | -19.4% |
| Large payload throughput | 63.61 MB/s | 1724.68 MB/s | -96.3% |

**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a 100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: `setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at concurrency 50 — so the 477 conn/s figure measures that delay, not its accept loop. effect-smtp greets immediately. Read the two throughput rows as the real comparison; the connection row is a protocol-policy difference.

