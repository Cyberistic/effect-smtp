/**
 * Node TCP/TLS Transport. The **only** file in `src/` allowed to import
 * `node:net` and `node:tls`. Everything else in the library is pure.
 */
import { Buffer } from "node:buffer";
import * as net from "node:net";
import * as tls from "node:tls";
import { Effect } from "effect";
import { SmtpError, SmtpTlsError } from "../errors.ts";
import type { SmtpConnection, Transport } from "./index.ts";
import {
  buildSocketConnection,
  closeSocketState,
  makeSocketState,
  pushChunk,
  type SocketState,
} from "./socket-connection.ts";

const SOCKET_KEY = Symbol.for("effect-smtp/node-tcp/socket");

interface WithSocket {
  [k: symbol]: net.Socket | tls.TLSSocket | undefined;
}

const attachSocket = (
  socket: net.Socket | tls.TLSSocket,
  state: SocketState,
): SmtpConnection => {
  socket.on("data", (chunk: Buffer | string) => {
    pushChunk(state, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  socket.on("close", () => closeSocketState(state));
  socket.on("error", () => closeSocketState(state));
  const conn = buildSocketConnection(
    state,
    (line) => socket.write(`${line}\r\n`),
    () => socket.end(),
  );
  (conn as unknown as WithSocket)[SOCKET_KEY] = socket;
  return conn;
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
      resume(
        Effect.succeed(attachSocket(socket, Effect.runSync(makeSocketState))),
      );
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
    const tlsSocket = tls.connect({ socket, rejectUnauthorized });
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
      resume(
        Effect.succeed(
          attachSocket(tlsSocket, Effect.runSync(makeSocketState)),
        ),
      );
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
