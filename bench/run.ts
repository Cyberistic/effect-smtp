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
import { median, SCENARIOS, type ScenarioResult } from "./scenarios.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const WARMUP_RUNS = 1;
const TIMED_RUNS = 3;
const READY_TIMEOUT_MS = 15_000;

interface Target {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const EFFECT_TARGET: Target = {
  name: "effect-smtp (nub / Node)",
  command: "nub",
  args: [resolve(HERE, "servers/effect-server.ts")],
};

const BUN_TARGET: Target = {
  name: "bun-smtp (Bun)",
  command: "bun",
  args: [resolve(HERE, "servers/bun-server.ts")],
};

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
    process.stdout.write(
      ` ${first.name}: ${median(runs.map((r) => r.metricValue)).toFixed(2)} ${first.unit}\n`,
    );
    results.set(first.name, {
      ...first,
      metricValue: median(runs.map((r) => r.metricValue)),
    });
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

  console.log(`→ ${EFFECT_TARGET.name}`);
  const effectResults = await runTarget(EFFECT_TARGET);

  console.log(`→ ${BUN_TARGET.name}`);
  const bunResults = await runTarget(BUN_TARGET);

  const lines: string[] = [];
  lines.push("# effect-smtp vs bun-smtp");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push(
    `Bun ${bunVersion}, Node ${nodeVersion}, ${cpuModel} (${cpus().length} cores)`,
  );
  lines.push("");
  lines.push(
    `Methodology: ${WARMUP_RUNS} discarded warmup run + ${TIMED_RUNS} timed runs per scenario, median reported. ` +
      "Each server runs as its own OS process: effect-smtp on Node (via nub), bun-smtp on Bun (its required runtime). " +
      "Both are driven by the same raw-TCP client (`bench/client.ts`) with a no-op DATA handler, `maxSize: 0` (effect-smtp) " +
      "matched to bun-smtp's `authOptional: true, disableReverseLookup: true`. Higher is better.",
  );
  lines.push("");
  lines.push(
    `| Scenario | ${EFFECT_TARGET.name} | ${BUN_TARGET.name} | effect-smtp vs bun-smtp |`,
  );
  lines.push("| --- | --- | --- | --- |");

  for (const [scenarioName, effectResult] of effectResults) {
    const bunResult = bunResults.get(scenarioName);
    if (!bunResult) continue;
    const pct =
      bunResult.metricValue === 0
        ? 0
        : ((effectResult.metricValue - bunResult.metricValue) /
            bunResult.metricValue) *
          100;
    lines.push(
      `| ${scenarioName} | ${formatMetric(effectResult)} | ${formatMetric(bunResult)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% |`,
    );
  }

  lines.push("");
  lines.push(
    "**Connection throughput is not a pure accept-loop comparison.** bun-smtp hardcodes a " +
      "100ms early-talker delay before it sends the 220 greeting (`src/connection.ts`: " +
      "`setTimeout(() => connectionReady(ctx), 100)`). With a fixed 100ms floor per " +
      "connection, bun-smtp's ceiling is `1000ms / 100ms × concurrency` ≈ 500 conn/s at " +
      "concurrency 50 — so the 477 conn/s figure measures that delay, not its accept loop. " +
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
