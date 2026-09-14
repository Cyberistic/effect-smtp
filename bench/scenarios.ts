/**
 * Benchmark scenarios, adapted from the bun-smtp reference bench so the
 * numbers are directly comparable. Three scenarios:
 *
 *   1. Connection throughput   — sequential connect→EHLO→QUIT round trips
 *   2. Concurrent transactions — N persistent connections doing MAIL/RCPT/DATA
 *   3. Large payload           — N connections streaming a ~1MB DATA body
 *
 * Every scenario returns a median over TIMED_RUNS after WARMUP_RUNS.
 */
import { SmtpBenchClient } from "./client.ts";

export interface ScenarioResult {
  readonly name: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly unit: string;
}

const OP_TIMEOUT_MS = 5_000;

export const withTimeout = <A>(
  promise: Promise<A>,
  ms: number,
  label: string,
): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label}: timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);

const makeBody = (sizeBytes: number): string => {
  const lineLen = 76;
  const line = "x".repeat(lineLen);
  const linesNeeded = Math.ceil(sizeBytes / (lineLen + 2));
  return Array.from({ length: linesNeeded }, () => line).join("\r\n");
};

const connectAndGreet = async (
  port: number,
  label: string,
): Promise<SmtpBenchClient> => {
  const client = new SmtpBenchClient();
  await withTimeout(client.connect(port), OP_TIMEOUT_MS, `${label}: connect`);
  await client.send("EHLO bench.local");
  await withTimeout(
    client.readResponse(),
    OP_TIMEOUT_MS,
    `${label}: EHLO response`,
  );
  return client;
};

/**
 * Concurrent connect→EHLO→QUIT round trips, `concurrency` in flight at
 * once. Unlike a sequential loop this measures accept-loop throughput
 * rather than greeting latency, so a fixed per-connection greeting
 * delay (bun-smtp's 100ms early-talker guard) amortizes instead of
 * dominating.
 */
export const connectionThroughput = async (
  port: number,
  count = 2_000,
  concurrency = 50,
): Promise<ScenarioResult> => {
  const one = async (i: number): Promise<void> => {
    const label = `connectionThroughput #${i}`;
    const client = new SmtpBenchClient();
    await withTimeout(client.connect(port), OP_TIMEOUT_MS, `${label}: connect`);
    await client.send("EHLO bench.local");
    await withTimeout(client.readResponse(), OP_TIMEOUT_MS, `${label}: EHLO`);
    await client.send("QUIT");
    await withTimeout(client.readResponse(), OP_TIMEOUT_MS, `${label}: QUIT`);
    client.close();
  };
  const start = performance.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const i = next++;
      await one(i);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedSec = (performance.now() - start) / 1_000;
  return {
    name: "Connection throughput",
    metricName: "connections/sec",
    metricValue: count / elapsedSec,
    unit: "conn/s",
  };
};

export const concurrentTransactionThroughput = async (
  port: number,
  concurrency = 50,
  durationMs = 5_000,
): Promise<ScenarioResult> => {
  const body = makeBody(200);
  const clients = await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      connectAndGreet(port, `concurrent setup #${i}`),
    ),
  );

  const start = performance.now();
  const deadline = start + durationMs;
  let totalMessages = 0;

  await Promise.all(
    clients.map(async (client, workerIdx) => {
      while (performance.now() < deadline) {
        const label = `concurrent worker #${workerIdx}`;
        await client.send("MAIL FROM:<bench@example.com>");
        await withTimeout(
          client.readResponse(),
          OP_TIMEOUT_MS,
          `${label}: MAIL`,
        );
        await client.send("RCPT TO:<rcpt@example.com>");
        await withTimeout(
          client.readResponse(),
          OP_TIMEOUT_MS,
          `${label}: RCPT`,
        );
        await client.send("DATA");
        await withTimeout(
          client.readResponse(),
          OP_TIMEOUT_MS,
          `${label}: DATA`,
        );
        await client.sendRaw(`${body}\r\n.\r\n`);
        await withTimeout(
          client.readResponse(),
          OP_TIMEOUT_MS,
          `${label}: end`,
        );
        totalMessages++;
      }
      client.close();
    }),
  );

  const elapsedSec = (performance.now() - start) / 1_000;
  return {
    name: "Concurrent transaction throughput",
    metricName: "messages/sec",
    metricValue: totalMessages / elapsedSec,
    unit: "msg/s",
  };
};

export const largePayloadThroughput = async (
  port: number,
  concurrency = 10,
  durationMs = 5_000,
  payloadBytes = 1_024 * 1_024,
): Promise<ScenarioResult> => {
  const body = makeBody(payloadBytes);
  const opTimeoutMs = Math.max(OP_TIMEOUT_MS, 15_000);
  const clients = await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      connectAndGreet(port, `large setup #${i}`),
    ),
  );

  const start = performance.now();
  const deadline = start + durationMs;
  let totalBytes = 0;

  await Promise.all(
    clients.map(async (client, workerIdx) => {
      while (performance.now() < deadline) {
        const label = `large worker #${workerIdx}`;
        await client.send("MAIL FROM:<bench@example.com>");
        await withTimeout(client.readResponse(), opTimeoutMs, `${label}: MAIL`);
        await client.send("RCPT TO:<rcpt@example.com>");
        await withTimeout(client.readResponse(), opTimeoutMs, `${label}: RCPT`);
        await client.send("DATA");
        await withTimeout(client.readResponse(), opTimeoutMs, `${label}: DATA`);
        await client.sendRaw(`${body}\r\n.\r\n`);
        await withTimeout(client.readResponse(), opTimeoutMs, `${label}: end`);
        totalBytes += body.length;
      }
      client.close();
    }),
  );

  const elapsedSec = (performance.now() - start) / 1_000;
  return {
    name: "Large payload throughput",
    metricName: "MB/sec",
    metricValue: totalBytes / (1_024 * 1_024) / elapsedSec,
    unit: "MB/s",
  };
};

export const SCENARIOS = [
  connectionThroughput,
  concurrentTransactionThroughput,
  largePayloadThroughput,
] as const;

export const median = (nums: ReadonlyArray<number>): number => {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};
