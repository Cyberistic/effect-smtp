# effect-smtp vs bun-smtp

Generated 2026-09-14T22:51:59.302Z
Bun 1.3.13, Node 26.8.1, Apple M2 Pro (12 cores)

Methodology: 2 discarded warmup runs + 5 timed runs per scenario, median reported. Each server runs as its own OS process and all are driven by the same raw-TCP client (`bench/client.ts`) with a no-op DATA handler, `maxSize: 0` (effect-smtp) matched to bun-smtp's `authOptional: true, disableReverseLookup: true`. The three targets separate the two effects: effect-smtp on Node vs on Bun isolates the runtime (same code), effect-smtp on Bun vs bun-smtp on Bun isolates the implementation. Higher is better.

Numbers are machine-dependent and the throughput scenarios move run-to-run (a shared CI box or a busy laptop swings them by an order of magnitude). Treat a single run as directional; compare medians across runs on a quiet machine before reading a gap as real.

| Scenario | effect-smtp (Node) | effect-smtp (Bun) | bun-smtp (Bun) | smtp-server (Node) | vs smtp-server (Node) |
| --- | --- | --- | --- | --- | --- |
| Connection throughput | 14551.40 conn/s | 13569.46 conn/s | 472.56 conn/s | 479.36 conn/s | +2935.6% |
| Concurrent transaction throughput | 14439.12 msg/s | 15263.77 msg/s | 18234.21 msg/s | 10593.20 msg/s | +36.3% |
| Large payload throughput | 356.43 MB/s | 726.22 MB/s | 1665.12 MB/s | 562.43 MB/s | -36.6% |

**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a 100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: `setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at concurrency 50 — so its figure measures that delay, not its accept loop. effect-smtp greets immediately. Read the two throughput rows as the real comparison; the connection row is a protocol-policy difference.

