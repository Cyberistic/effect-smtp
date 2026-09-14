# effect-smtp vs bun-smtp

Generated 2026-09-14T23:12:28.349Z
Bun 1.3.13, Node 26.8.1, Apple M2 Pro (12 cores)

Methodology: 2 discarded warmup runs + 5 timed runs per scenario, median reported. Each server runs as its own OS process and all are driven by the same raw-TCP client (`bench/client.ts`) with a no-op DATA handler, `maxSize: 0` (effect-smtp) matched to bun-smtp's `authOptional: true, disableReverseLookup: true`. The three targets separate the two effects: effect-smtp on Node vs on Bun isolates the runtime (same code), effect-smtp on Bun vs bun-smtp on Bun isolates the implementation. Higher is better.

Numbers are machine-dependent and the throughput scenarios move run-to-run (a shared CI box or a busy laptop swings them by an order of magnitude). Treat a single run as directional; compare medians across runs on a quiet machine before reading a gap as real.

| Scenario | effect-smtp (Node) | effect-smtp (Bun) | bun-smtp (Bun) | smtp-server (Node) | vs smtp-server (Node) |
| --- | --- | --- | --- | --- | --- |
| Connection throughput | 14306.55 conn/s | 11166.17 conn/s | 470.20 conn/s | 466.90 conn/s | +2964.2% |
| Concurrent transaction throughput | 14325.37 msg/s | 15741.96 msg/s | 20082.55 msg/s | 19591.50 msg/s | -26.9% |
| Large payload throughput | 359.50 MB/s | 776.51 MB/s | 1650.99 MB/s | 566.42 MB/s | -36.5% |

**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a 100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: `setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at concurrency 50 — so its figure measures that delay, not its accept loop. effect-smtp greets immediately. Read the two throughput rows as the real comparison; the connection row is a protocol-policy difference.

