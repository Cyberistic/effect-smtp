/**
 * Node TCP/TLS Transport. The **only** file in `src/` allowed to import
 * `node:net` and `node:tls`. Everything else in the library is pure.
 */
import { Buffer } from "node:buffer";
import * as net from "node:net";
import * as tls from "node:tls";
import { Effect, Queue, Ref } from "effect";
import { SmtpConnectionClosed, SmtpError, SmtpTlsError } from "../errors.ts";
import type { SmtpConnection, Transport } from "./index.ts";

const SOCKET_KEY = Symbol.for("effect-smtp/node-tcp/socket");

interface WithSocket {
  [k: symbol]: net.Socket | tls.TLSSocket | undefined;
}

const stripCRLF = (line: string): string =>
  line.endsWith("\r\n") ? line.slice(0, -2) : line;

const makeState = Effect.gen(function* () {
  const incomingLines = yield* Queue.unbounded<string>();
  const closed = yield* Ref.make(false);
  return { incomingLines, closed };
});

const buildConnection = (
  socket: net.Socket | tls.TLSSocket,
  state: {
    readonly incomingLines: Queue.Queue<string>;
    readonly closed: Ref.Ref<boolean>;
  },
): SmtpConnection => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer | string) => {
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, raw]);
    let nl = buffer.indexOf(0x0a);
    while (nl !== -1) {
      const end = nl > 0 && buffer[nl - 1] === 0x0d ? nl - 1 : nl;
      const line = buffer.subarray(0, end).toString("utf8");
      if (!Queue.offerUnsafe(state.incomingLines, line)) return;
      buffer = buffer.subarray(nl + 1);
      nl = buffer.indexOf(0x0a);
    }
  });
  socket.on("close", () => {
    Effect.runSync(Ref.set(state.closed, true));
    Queue.offerUnsafe(state.incomingLines, "");
  });
  socket.on("error", () => {
    Effect.runSync(Ref.set(state.closed, true));
    Queue.offerUnsafe(state.incomingLines, "");
  });

  return {
    readLine: Effect.gen(function* () {
      const isClosed = yield* Ref.get(state.closed);
      if (isClosed) {
        return yield* Effect.fail(
          new SmtpConnectionClosed({ during: "readLine" }),
        );
      }
      const line = yield* Queue.take(state.incomingLines);
      const isClosedNow = yield* Ref.get(state.closed);
      if (isClosedNow && line === "") {
        return yield* Effect.fail(
          new SmtpConnectionClosed({ during: "readLine" }),
        );
      }
      return stripCRLF(line);
    }),
    writeLine: (line) =>
      Effect.gen(function* () {
        const isClosed = yield* Ref.get(state.closed);
        if (isClosed) {
          return yield* Effect.fail(
            new SmtpConnectionClosed({ during: `writeLine(${line})` }),
          );
        }
        yield* Effect.sync(() => {
          socket.write(`${line}\r\n`);
        });
      }),
    close: Effect.sync(() => socket.end()),
  } as SmtpConnection & WithSocket;
};

const connectPlain = (
  host: string,
  port: number,
  timeoutMs: number | undefined,
): Effect.Effect<SmtpConnection, SmtpError> =>
  Effect.callback<SmtpConnection, SmtpError>((resume) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
    };
    if (timeoutMs !== undefined) {
      socket.setTimeout(timeoutMs);
      socket.once("timeout", () => {
        cleanup();
        socket.destroy();
        resume(
          Effect.fail(
            new SmtpError({
              kind: "connect-timeout",
              message: `effect-smtp: connect timed out after ${timeoutMs}ms`,
            }),
          ),
        );
      });
    }
    socket.once("error", (err: Error) => {
      cleanup();
      resume(
        Effect.fail(
          new SmtpError({
            kind: "connect",
            message: `effect-smtp: connect failed: ${err.message}`,
            cause: err,
          }),
        ),
      );
    });
    socket.once("connect", () => {
      cleanup();
      const state = Effect.runSync(makeState);
      const conn = buildConnection(socket, state) as SmtpConnection &
        WithSocket;
      conn[SOCKET_KEY] = socket;
      resume(Effect.succeed(conn));
    });
  });

const upgradeTlsImpl = (
  conn: SmtpConnection,
  rejectUnauthorized: boolean,
): Effect.Effect<SmtpConnection, SmtpTlsError> =>
  Effect.callback<SmtpConnection, SmtpTlsError>((resume) => {
    const socket = (conn as unknown as WithSocket)[SOCKET_KEY];
    if (!(socket instanceof net.Socket)) {
      resume(Effect.fail(new SmtpTlsError({ stage: "wrap" })));
      return;
    }
    const tlsSocket = tls.connect({
      socket,
      rejectUnauthorized,
    });
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      tlsSocket.removeAllListeners();
    };
    tlsSocket.once("error", () => {
      cleanup();
      resume(Effect.fail(new SmtpTlsError({ stage: "handshake" })));
    });
    tlsSocket.once("secureConnect", () => {
      cleanup();
      const state = Effect.runSync(makeState);
      const wrapped = buildConnection(tlsSocket, state) as SmtpConnection &
        WithSocket;
      wrapped[SOCKET_KEY] = tlsSocket;
      resume(Effect.succeed(wrapped));
    });
  });

export interface NodeTcpTransportOptions {
  readonly rejectUnauthorized?: boolean;
}

export const makeNodeTcpTransport = (
  options: NodeTcpTransportOptions = {},
): Transport => ({
  connect: ({ host, port, timeoutMs }) => connectPlain(host, port, timeoutMs),
  upgradeTls: (conn) =>
    upgradeTlsImpl(conn, options.rejectUnauthorized ?? true),
});
