/**
 * Benchmark orchestrator: effect-smtp vs bun-smtp, driven through the
 * same raw-TCP client and the same three scenarios. Spawns each server
 * as a separate OS process, waits for READY, runs the scenarios, and
 * writes bench/RESULTS.md.
 *
 * Usage: nub bench/run.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpus } from "node:os";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SCENARIOS, type ScenarioResult } from "./scenarios.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const WARMUP_RUNS = 2;
const TIMED_RUNS = 5;
const READY_TIMEOUT_MS = 15_000;

interface Target {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Three targets, so a gap can be attributed: effect-smtp on Node vs on
 * Bun isolates the runtime (same code), and effect-smtp-on-Bun vs
 * bun-smtp-on-Bun isolates the implementation (same runtime).
 */
const TARGETS: ReadonlyArray<Target> = [
  {
    name: "effect-smtp (Node)",
    command: "nub",
    args: [resolve(HERE, "servers/effect-server.ts")],
  },
  {
    name: "effect-smtp (Bun)",
    command: "bun",
    args: [resolve(HERE, "servers/effect-server.ts")],
  },
  {
    name: "bun-smtp (Bun)",
    command: "bun",
    args: [resolve(HERE, "servers/bun-server.ts")],
  },
  {
    name: "smtp-server (Node)",
    command: "nub",
    args: [resolve(HERE, "servers/smtp-server.ts")],
  },
];

const randomPort = (): number => 20_000 + Math.floor(Math.random() * 20_000);

const waitForReady = (child: ChildProcess, timeoutMs: number): Promise<void> =>
  new Promise((resolveReady, rejectReady) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      if (buf.includes("READY")) {
        cleanup();
        resolveReady();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectReady(
        new Error(`server exited before READY (code ${code})\n${buf}`),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(new Error(`timed out waiting for READY\n${buf}`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.removeListener("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });

const runScenariosAgainst = async (
  port: number,
): Promise<Map<string, ScenarioResult>> => {
  const results = new Map<string, ScenarioResult>();
  for (const scenario of SCENARIOS) {
    const runs: ScenarioResult[] = [];
    for (let i = 0; i < WARMUP_RUNS; i++) {
      await scenario(port);
    }
    for (let i = 0; i < TIMED_RUNS; i++) {
      process.stdout.write(".");
      runs.push(await scenario(port));
    }
    const first = runs[0];
    if (!first) continue;
    // Best-of-N, not median: a shared dev machine injects downward noise
    // (other processes stealing CPU) that a median faithfully reports but
    // that has nothing to do with the server. The peak run is the closest
    // estimate of what each server can actually do.
    const best = Math.max(...runs.map((r) => r.metricValue));
    process.stdout.write(` ${first.name}: ${best.toFixed(2)} ${first.unit}\n`);
    results.set(first.name, { ...first, metricValue: best });
  }
  return results;
};

const runTarget = async (
  target: Target,
): Promise<Map<string, ScenarioResult>> => {
  const port = randomPort();
  const child = spawn(target.command, [...target.args, String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await waitForReady(child, READY_TIMEOUT_MS);
    return await runScenariosAgainst(port);
  } finally {
    child.kill("SIGKILL");
  }
};

const formatMetric = (r: ScenarioResult): string =>
  `${r.metricValue.toFixed(2)} ${r.unit}`;

const main = async (): Promise<void> => {
  const nodeVersion = process.versions.node;
  const bunVersion = await new Promise<string>((resolveVersion) => {
    const p = spawn("bun", ["--version"]);
    let out = "";
    p.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("close", () => resolveVersion(out.trim()));
  });
  const cpuModel = cpus()[0]?.model ?? "unknown CPU";

  console.log(
    `Bun ${bunVersion} / Node ${nodeVersion} / ${cpuModel} (${cpus().length} cores)\n`,
  );

  const results = new Map<string, Map<string, ScenarioResult>>();
  for (const target of TARGETS) {
    console.log(`→ ${target.name}`);
    results.set(target.name, await runTarget(target));
  }

  const baseline = TARGETS[TARGETS.length - 1];
  if (!baseline) throw new Error("no targets");

  const lines: string[] = [];
  lines.push("# effect-smtp vs bun-smtp");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push(
    `Bun ${bunVersion}, Node ${nodeVersion}, ${cpuModel} (${cpus().length} cores)`,
  );
  lines.push("");
  lines.push(
    `Methodology: ${WARMUP_RUNS} discarded warmup runs + ${TIMED_RUNS} timed runs per scenario, best-of reported. ` +
      "Each server runs as its own OS process and all are driven by the same raw-TCP client (`bench/client.ts`) " +
      "with a no-op DATA handler, `maxSize: 0` (effect-smtp) matched to bun-smtp's `authOptional: true, " +
      "disableReverseLookup: true`. The three targets separate the two effects: effect-smtp on Node vs on Bun " +
      "isolates the runtime (same code), effect-smtp on Bun vs bun-smtp on Bun isolates the implementation. " +
      "Higher is better.",
  );
  lines.push("");
  lines.push(
    "Best-of-N rather than median: on a shared dev machine other processes steal CPU and " +
      "depress every run, which a median reports faithfully but which says nothing about the " +
      "server under test. The peak run is the closest estimate of each server's ceiling. " +
      "Numbers are still machine-dependent — read a gap under ~15% as noise.",
  );
  lines.push("");
  lines.push(
    `| Scenario | ${TARGETS.map((t) => t.name).join(" | ")} | vs ${baseline.name} |`,
  );
  lines.push(`| --- |${TARGETS.map(() => " --- |").join("")} --- |`);

  const firstResults = results.get(TARGETS[0]?.name ?? "");
  if (firstResults) {
    for (const [scenarioName, first] of firstResults) {
      const cells = TARGETS.map((t) => {
        const r = results.get(t.name)?.get(scenarioName);
        return r ? formatMetric(r) : "—";
      });
      const baselineResult = results.get(baseline.name)?.get(scenarioName);
      const pct =
        !baselineResult || baselineResult.metricValue === 0
          ? 0
          : ((first.metricValue - baselineResult.metricValue) /
              baselineResult.metricValue) *
            100;
      lines.push(
        `| ${scenarioName} | ${cells.join(" | ")} | ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% |`,
      );
    }
  }

  lines.push("");
  lines.push(
    "**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a " +
      "100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: " +
      "`setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per " +
      "connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at " +
      "concurrency 50 — so its figure measures that delay, not its accept loop. " +
      "effect-smtp greets immediately. Read the two throughput rows as the real comparison; " +
      "the connection row is a protocol-policy difference.",
  );
  lines.push("");
  const output = `${lines.join("\n")}\n`;
  console.log(`\n${output}`);
  await writeFile(resolve(HERE, "RESULTS.md"), output);
  console.log(`results written to bench/RESULTS.md`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
