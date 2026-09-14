import { Effect, Queue, Ref } from "effect";
import { SmtpConnectionClosed } from "../errors.ts";
import type { SmtpConnection } from "./index.ts";

/**
 * Shared byte-stream plumbing for the two network transports (the Node
 * TCP/TLS client transport and the Node TCP server). Both reduce to the
 * same shape: a socket emits raw chunks on the event loop, and callers
 * consume either whole lines (`readLine`, command mode) or raw chunks
 * (`readChunk`, DATA mode).
 *
 * Chunks arrive on a single Queue and are never split on the socket
 * side; `readLine` derives lines from them with a shared remainder
 * buffer. That keeps a command → DATA → command session coherent — the
 * bytes `readLine` would have split are exactly the bytes `readChunk`
 * returns — while making bulk DATA a handful of reads instead of one
 * Effect per line.
 */

const EMPTY = new Uint8Array(0);
const LF = 0x0a;
const CR = 0x0d;

export interface SocketState {
  readonly chunks: Queue.Queue<Uint8Array>;
  readonly lineBuffer: Ref.Ref<Uint8Array>;
  readonly closed: Ref.Ref<boolean>;
}

export const makeSocketState: Effect.Effect<SocketState, never, never> =
  Effect.gen(function* () {
    const chunks = yield* Queue.unbounded<Uint8Array>();
    const lineBuffer = yield* Ref.make<Uint8Array>(EMPTY);
    const closed = yield* Ref.make(false);
    return { chunks, lineBuffer, closed };
  });

/** Offer a socket chunk to the reader. Safe to call from a raw event handler. */
export const pushChunk = (state: SocketState, chunk: Uint8Array): void => {
  Queue.offerUnsafe(state.chunks, chunk);
};

/**
 * Mark the connection closed and unblock any pending read. Safe to call
 * from a raw event handler.
 */
export const closeSocketState = (state: SocketState): void => {
  Effect.runSync(Ref.set(state.closed, true));
  Queue.offerUnsafe(state.chunks, EMPTY);
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * Build the `SmtpConnection` over a `SocketState`. `write` sends one
 * CRLF-terminated line; `end` closes the socket.
 */
export const buildSocketConnection = (
  state: SocketState,
  write: (line: string) => void,
  end: () => void,
): SmtpConnection => {
  const decoder = new TextDecoder();

  return {
    readLine: Effect.gen(function* () {
      while (true) {
        const isClosed = yield* Ref.get(state.closed);
        const buffered = yield* Ref.get(state.lineBuffer);
        const nl = buffered.indexOf(LF);
        if (nl !== -1) {
          const endIdx = nl > 0 && buffered[nl - 1] === CR ? nl - 1 : nl;
          const line = decoder.decode(buffered.subarray(0, endIdx));
          yield* Ref.set(state.lineBuffer, buffered.subarray(nl + 1));
          return line;
        }
        if (isClosed) {
          return yield* Effect.fail(
            new SmtpConnectionClosed({ during: "readLine" }),
          );
        }
        const chunk = yield* Queue.take(state.chunks);
        if (chunk.length === 0) {
          const nowClosed = yield* Ref.get(state.closed);
          if (nowClosed) {
            return yield* Effect.fail(
              new SmtpConnectionClosed({ during: "readLine" }),
            );
          }
          continue;
        }
        yield* Ref.set(state.lineBuffer, concat(buffered, chunk));
      }
    }),
    readChunk: Effect.gen(function* () {
      while (true) {
        const isClosed = yield* Ref.get(state.closed);
        const buffered = yield* Ref.get(state.lineBuffer);
        if (buffered.length > 0) {
          yield* Ref.set(state.lineBuffer, EMPTY);
          return buffered;
        }
        if (isClosed) {
          return yield* Effect.fail(
            new SmtpConnectionClosed({ during: "readChunk" }),
          );
        }
        const chunk = yield* Queue.take(state.chunks);
        if (chunk.length === 0) {
          const nowClosed = yield* Ref.get(state.closed);
          if (nowClosed) {
            return yield* Effect.fail(
              new SmtpConnectionClosed({ during: "readChunk" }),
            );
          }
          continue;
        }
        return chunk;
      }
    }),
    writeLine: (line) =>
      Effect.gen(function* () {
        const isClosed = yield* Ref.get(state.closed);
        if (isClosed) {
          return yield* Effect.fail(
            new SmtpConnectionClosed({ during: `writeLine(${line})` }),
          );
        }
        yield* Effect.sync(() => write(line));
      }),
    close: Effect.sync(end),
  };
};
