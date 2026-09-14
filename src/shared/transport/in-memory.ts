import { Effect, Queue, Ref } from "effect";
import { SmtpConnectionClosed } from "../errors.ts";
import type { SmtpConnection, Transport } from "./index.ts";

/**
 * In-memory Transport for tests and dry runs. Captures every line the
 * client writes; replays a scripted server reply stream; supports a
 * stub STARTTLS upgrade that swaps the underlying queue pair for a
 * fresh one (purely symbolic — same Queue semantics, no real crypto).
 */

export interface InMemoryTransportOptions {
  /**
   * Pre-canned server replies, queued eagerly so the first `readLine`
   * returns the SMTP greeting. Each subsequent server message is
   * offered into the read queue in order via `enqueueReplies`.
   */
  readonly replies?: ReadonlyArray<string>;
}

export interface InMemoryTransport extends Transport {
  /** Lines the client wrote, captured for assertion. */
  readonly written: Effect.Effect<ReadonlyArray<string>, never>;
  /** Append more scripted server replies (consumed FIFO on read). */
  readonly enqueueReplies: (
    replies: ReadonlyArray<string>,
  ) => Effect.Effect<void, never>;
}

const stripCRLF = (line: string): string =>
  line.endsWith("\r\n") ? line.slice(0, -2) : line;

interface InMemoryState {
  readonly serverToClient: Queue.Queue<string>;
  readonly closed: Ref.Ref<boolean>;
}

const makeState = Effect.gen(function* () {
  const serverToClient = yield* Queue.unbounded<string>();
  const closed = yield* Ref.make(false);
  return { serverToClient, closed } satisfies InMemoryState;
});

const seedQueue = <A>(
  queue: Queue.Queue<A>,
  lines: ReadonlyArray<A>,
): Effect.Effect<void, never> =>
  Queue.offerAll(queue, lines).pipe(Effect.asVoid);

export const makeInMemoryTransport = (
  options: InMemoryTransportOptions = {},
): Effect.Effect<InMemoryTransport, never, never> =>
  Effect.gen(function* () {
    const writtenRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const stateRef = yield* Ref.make(yield* makeState);

    const connection: SmtpConnection = {
      readLine: Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const isClosed = yield* Ref.get(state.closed);
        if (isClosed) {
          return yield* Effect.fail(
            new SmtpConnectionClosed({ during: "readLine" }),
          );
        }
        const line = yield* Queue.take(state.serverToClient);
        return stripCRLF(line);
      }),
      writeLine: (line) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const isClosed = yield* Ref.get(state.closed);
          if (isClosed) {
            return yield* Effect.fail(
              new SmtpConnectionClosed({ during: `writeLine(${line})` }),
            );
          }
          yield* Ref.update(writtenRef, (ws) => [...ws, line]);
        }),
      close: Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        yield* Ref.set(state.closed, true);
      }),
    };

    const transport: InMemoryTransport = {
      connect: (_options) =>
        Effect.gen(function* () {
          const fresh = yield* makeState;
          yield* Ref.set(stateRef, fresh);
          yield* seedQueue(fresh.serverToClient, options.replies ?? []);
          return connection;
        }),
      upgradeTls: (_conn) =>
        Effect.gen(function* () {
          const fresh = yield* makeState;
          yield* Ref.set(stateRef, fresh);
          yield* seedQueue(fresh.serverToClient, options.replies ?? []);
          return connection;
        }),
      written: Ref.get(writtenRef),
      enqueueReplies: (lines) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          yield* seedQueue(state.serverToClient, lines);
        }),
    };
    return transport;
  });
