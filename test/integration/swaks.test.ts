import { describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import { listenSmtp } from "../../src/server/server.ts";
import { findFreePort } from "./_helpers.ts";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

describe("swaks compatibility", () => {
  it("accepts a swaks submission", async () => {
    const port = await findFreePort();
    const collected: Array<{ from: string; subject: string }> = [];

    const serverProgram = Effect.scoped(
      Effect.gen(function* () {
        yield* listenSmtp({
          port,
          name: "effect-smtp.test",
          maxSize: 0,
          onData: (stream) =>
            Effect.gen(function* () {
              const lines = yield* stream.lines;
              const fromLine =
                lines.find((l) => l.toLowerCase().startsWith("from:")) ?? "";
              const fromMatch = /<([^>]+)>/.exec(fromLine);
              const from = fromMatch?.[1] ?? "";
              const subject =
                lines
                  .find((l) => l.toLowerCase().startsWith("subject:"))
                  ?.split(":")[1]
                  ?.trim() ?? "";
              collected.push({ from, subject });
            }),
        });
        yield* Effect.never;
      }),
    );
    const fiber = Effect.runFork(serverProgram);

    try {
      await Effect.runPromise(Effect.sleep("150 millis"));

      const cmd = [
        "swaks",
        "--server 127.0.0.1",
        `--port ${port}`,
        "--from swaks@example.com",
        "--to bob@example.com",
        "--header 'Subject: swaks compatibility'",
        "--body 'swaks body'",
        "--timeout 10",
      ].join(" ");

      const { stdout, stderr } = await execAsync(cmd);
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toMatch(/250|Message accepted|queued/i);

      await Effect.runPromise(Effect.sleep("200 millis"));
      expect(collected).toHaveLength(1);
      expect(collected[0]?.subject).toBe("swaks compatibility");
    } finally {
      Effect.runFork(Fiber.interrupt(fiber));
    }
  });
});
