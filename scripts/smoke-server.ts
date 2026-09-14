import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Fiber } from "effect";
import { listenSmtp } from "../src/server/server.ts";
import { findFreePort } from "../test/integration/_helpers.ts";

const execAsync = promisify(exec);

const main = Effect.scoped(
  Effect.gen(function* () {
    const port = yield* Effect.promise(() => findFreePort());
    const received: Array<{ subject: string }> = [];

    const serverProgram = Effect.gen(function* () {
      yield* listenSmtp({
        port,
        name: "effect-smtp.smoke",
        maxSize: 0,
        onData: (stream) =>
          Effect.gen(function* () {
            const lines = yield* stream.lines;
            const subject =
              lines
                .find((l) => l.toLowerCase().startsWith("subject:"))
                ?.split(":")[1]
                ?.trim() ?? "";
            received.push({ subject });
          }),
      });
      yield* Effect.never;
    });

    const fiber = yield* serverProgram.pipe(Effect.forkChild);
    yield* Effect.sleep("150 millis");

    yield* Effect.tryPromise(() =>
      execAsync(
        `swaks --server 127.0.0.1 --port ${port} ` +
          `--from smoke@effect-smtp.test --to dest@example.com ` +
          `--header 'Subject: effect-smtp smoke' --body 'sent via swaks' ` +
          `--timeout 10`,
      ),
    );

    yield* Effect.sleep("150 millis");

    if (received.length === 0) {
      yield* Effect.logError("no messages received");
      yield* Effect.sync(() => process.exit(1));
    }

    yield* Effect.log(
      `received: ${received.length} message(s), subject="${received[0]?.subject}"`,
    );
    yield* Fiber.interrupt(fiber);
  }),
);

Effect.runPromise(main).catch((err) => {
  console.error(err);
  process.exit(1);
});
