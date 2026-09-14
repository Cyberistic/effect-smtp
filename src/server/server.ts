/**
 * Node TCP server. The **only** file in `src/server/` allowed to import
 * `node:net`. Forks one Fiber per accepted connection. The server does
 * not use the client-side `Transport` seam — it builds `SmtpConnection`
 * values directly from raw sockets.
 */
import { Buffer } from "node:buffer";
import * as net from "node:net";
import * as tls from "node:tls";
import { Effect, Fiber, Scope } from "effect";
import { SmtpError } from "../shared/errors.ts";
import type { SmtpConnection } from "../shared/transport/index.ts";
import {
  buildSocketConnection,
  closeSocketState,
  makeSocketState,
  pushChunk,
  type SocketState,
} from "../shared/transport/socket-connection.ts";
import {
  handleConnection,
  type HandleConnectionOptions,
  type ServerSessionOptions,
} from "./session.ts";

const SOCKET_KEY = Symbol.for("effect-smtp/node-server/socket");

const buildConnectionFromSocket = (
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
  (conn as unknown as { [k: symbol]: net.Socket | tls.TLSSocket })[SOCKET_KEY] =
    socket;
  return conn;
};

export interface SmtpServerOptions {
  readonly host?: string;
  readonly port: number;
  readonly name?: string;
  readonly banner?: string;
  readonly lmtp?: boolean;
  readonly authMethods?: ReadonlyArray<
    "PLAIN" | "LOGIN" | "CRAM-MD5" | "XOAUTH2"
  >;
  readonly maxSize?: number;
  readonly tls?: { readonly key: string; readonly cert: string };
  readonly onAuth?: ServerSessionOptions["onAuth"];
  readonly onMailFrom?: ServerSessionOptions["onMailFrom"];
  readonly onRcptTo?: ServerSessionOptions["onRcptTo"];
  readonly onData: ServerSessionOptions["onData"];
  readonly onClose?: ServerSessionOptions["onClose"];
  readonly socketTimeoutMs?: number;
}

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  readonly close: Effect.Effect<void, never>;
}

const makeSessionOptions = (
  options: SmtpServerOptions,
): ServerSessionOptions => {
  const name = options.name ?? "effect-smtp";
  return {
    name,
    banner: options.banner ?? "",
    lmtp: options.lmtp ?? false,
    authMethods: options.authMethods ?? [],
    maxSize: options.maxSize ?? 25_000_000,
    socketTimeoutMs: options.socketTimeoutMs ?? 60_000,
    onAuth: options.onAuth,
    onMailFrom: options.onMailFrom,
    onRcptTo: options.onRcptTo,
    onData: options.onData,
    onClose: options.onClose,
  };
};

export const listenSmtp = (
  options: SmtpServerOptions,
): Effect.Effect<RunningServer, SmtpError, Scope.Scope> =>
  Effect.gen(function* () {
    const server = net.createServer();
    const connectionFibers = new Set<Fiber.Fiber<void, never>>();

    yield* Effect.callback<void, SmtpError>((resume) => {
      server.once("error", (err: Error) => {
        resume(
          Effect.fail(
            new SmtpError({
              kind: "listen",
              message: `effect-smtp: listen failed: ${err.message}`,
              cause: err,
            }),
          ),
        );
      });
      server.listen(options.port, options.host ?? "127.0.0.1", () => {
        resume(Effect.succeed(undefined));
      });
    });

    const tlsKey = options.tls?.key;
    const tlsCert = options.tls?.cert;
    let connectionCounter = 0;

    const upgradeTlsForSocket = (
      conn: SmtpConnection,
      socket: net.Socket,
    ): Effect.Effect<SmtpConnection, SmtpError> =>
      Effect.callback<SmtpConnection, SmtpError>((resume) => {
        if (!tlsKey || !tlsCert) {
          resume(
            Effect.fail(
              new SmtpError({ kind: "tls", message: "no TLS configured" }),
            ),
          );
          return;
        }
        const tlsSocket = tls.connect({
          socket,
          key: tlsKey,
          cert: tlsCert,
          rejectUnauthorized: false,
        });
        tlsSocket.once("error", () => {
          resume(
            Effect.fail(
              new SmtpError({ kind: "tls", message: "TLS handshake failed" }),
            ),
          );
        });
        tlsSocket.once("secureConnect", () => {
          resume(
            Effect.succeed(
              buildConnectionFromSocket(
                tlsSocket,
                Effect.runSync(makeSocketState),
              ),
            ),
          );
        });
      });

    server.on("connection", (socket: net.Socket) => {
      connectionCounter += 1;
      const id = `c${connectionCounter}`;
      const conn = buildConnectionFromSocket(
        socket,
        Effect.runSync(makeSocketState),
      );

      const upgradeTls = (
        current: SmtpConnection,
      ): Effect.Effect<SmtpConnection, SmtpError> => {
        const s = (
          current as unknown as { [SOCKET_KEY]?: net.Socket | tls.TLSSocket }
        )[SOCKET_KEY];
        const baseSocket = s instanceof net.Socket ? s : socket;
        return upgradeTlsForSocket(current, baseSocket);
      };

      const handleOpts: HandleConnectionOptions = {
        conn,
        sessionOptions: makeSessionOptions(options),
        id,
        remoteAddress: socket.remoteAddress ?? "",
        remotePort: socket.remotePort ?? 0,
        localAddress: socket.localAddress ?? "",
        localPort: socket.localPort ?? 0,
        upgradeTls,
        tlsAvailable: tlsKey !== undefined && tlsCert !== undefined,
      };

      const program = handleConnection(handleOpts);
      const fiber = Effect.runFork(program);
      connectionFibers.add(fiber);

      socket.on("close", () => {
        connectionFibers.delete(fiber);
        Effect.runFork(Fiber.interrupt(fiber));
      });
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const f of connectionFibers) {
          Effect.runFork(Fiber.interrupt(f));
        }
        server.close();
      }),
    );

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : options.port;
    const host =
      typeof addr === "object" && addr
        ? addr.address
        : (options.host ?? "127.0.0.1");
    return {
      host,
      port,
      close: Effect.sync(() => {
        for (const f of connectionFibers) {
          Effect.runFork(Fiber.interrupt(f));
        }
        server.close();
      }),
    } satisfies RunningServer;
  });
