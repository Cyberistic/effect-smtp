/**
 * Benchmark target: our effect-smtp server. Usage:
 *   nub bench/servers/effect-server.ts <port>
 * Prints READY on stdout once listening.
 */
import { Effect } from "effect";
import { listenSmtp } from "../../src/server/server.ts";

const port = Number(process.argv[2] ?? 0);

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* listenSmtp({
      port,
      host: "127.0.0.1",
      name: "effect-smtp.bench",
      maxSize: 0,
      onData: () => Effect.void,
    });
    console.log("READY");
    yield* Effect.never;
  }),
);

Effect.runPromise(program).catch((err) => {
  console.error(err);
  process.exit(1);
});
