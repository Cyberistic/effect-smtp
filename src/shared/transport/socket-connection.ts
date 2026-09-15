import { Effect, Queue } from "effect";
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
 *
 * The remainder and closed flag are plain fields, not `Ref`s: a
 * connection is owned by one reader fiber and Node's socket callbacks
 * run on the same thread, so there is no concurrent access to guard.
 * Keeping them out of `Ref` takes the per-command `Ref` round-trips off
 * the hot path.
 */

const EMPTY = new Uint8Array(0);
const LF = 0x0a;
const CR = 0x0d;

export interface SocketState {
  readonly chunks: Queue.Queue<Uint8Array>;
  /** Bytes held over from the previous chunk (a partial line). */
  lineBuffer: Uint8Array;
  closed: boolean;
}

export const makeSocketState = (): SocketState => ({
  chunks: Effect.runSync(Queue.unbounded<Uint8Array>()),
  lineBuffer: EMPTY,
  closed: false,
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
  state.closed = true;
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

const closedError = (during: string): SmtpConnectionClosed =>
  new SmtpConnectionClosed({ during });

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

  const readLine: SmtpConnection["readLine"] = Effect.suspend(() => {
    const buffered = state.lineBuffer;
    const nl = buffered.indexOf(LF);
    if (nl !== -1) {
      const endIdx = nl > 0 && buffered[nl - 1] === CR ? nl - 1 : nl;
      const line = decoder.decode(buffered.subarray(0, endIdx));
      state.lineBuffer = buffered.subarray(nl + 1);
      return Effect.succeed(line);
    }
    if (state.closed) return Effect.fail(closedError("readLine"));
    return Queue.take(state.chunks).pipe(
      Effect.flatMap((chunk) => {
        if (chunk.length > 0) {
          state.lineBuffer = concat(buffered, chunk);
          return readLine;
        }
        return state.closed ? Effect.fail(closedError("readLine")) : readLine;
      }),
    );
  });

  const readChunk: SmtpConnection["readChunk"] = Effect.suspend(() => {
    const buffered = state.lineBuffer;
    if (buffered.length > 0) {
      state.lineBuffer = EMPTY;
      return Effect.succeed(buffered);
    }
    if (state.closed) return Effect.fail(closedError("readChunk"));
    return Queue.take(state.chunks).pipe(
      Effect.flatMap((chunk) =>
        chunk.length === 0 && state.closed
          ? Effect.fail(closedError("readChunk"))
          : Effect.succeed(chunk),
      ),
    );
  });

  return {
    readLine,
    readChunk,
    writeLine: (line) =>
      Effect.suspend(() => {
        if (state.closed) {
          return Effect.fail(closedError(`writeLine(${line})`));
        }
        write(line);
        return Effect.void;
      }),
    close: Effect.sync(end),
  };
};
