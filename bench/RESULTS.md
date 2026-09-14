# effect-smtp vs bun-smtp

Generated 2026-09-14T22:17:29.529Z
Bun 1.3.13, Node 26.8.1, Apple M2 Pro (12 cores)

Methodology: 2 discarded warmup runs + 5 timed runs per scenario, median reported. Each server runs as its own OS process: effect-smtp on Node (via nub), bun-smtp on Bun (its required runtime). Both are driven by the same raw-TCP client (`bench/client.ts`) with a no-op DATA handler, `maxSize: 0` (effect-smtp) matched to bun-smtp's `authOptional: true, disableReverseLookup: true`. Higher is better.

Numbers are machine-dependent and the two throughput scenarios still move run-to-run (a shared CI box or a busy laptop swings them by an order of magnitude). Treat a single run as directional; compare medians across runs on a quiet machine before reading a gap as real.

| Scenario | effect-smtp (nub / Node) | bun-smtp (Bun) | effect-smtp vs bun-smtp |
| --- | --- | --- | --- |
| Connection throughput | 14941.58 conn/s | 475.82 conn/s | +3040.2% |
| Concurrent transaction throughput | 16320.86 msg/s | 18398.32 msg/s | -11.3% |
| Large payload throughput | 482.98 MB/s | 1585.78 MB/s | -69.5% |

**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a 100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: `setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at concurrency 50 — so the 477 conn/s figure measures that delay, not its accept loop. effect-smtp greets immediately. Read the two throughput rows as the real comparison; the connection row is a protocol-policy difference.

