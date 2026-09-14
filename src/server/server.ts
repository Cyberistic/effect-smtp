/**
 * Node TCP server. The **only** file in `src/server/` allowed to import
 * `node:net`. Forks one Fiber per accepted connection. The server does
 * not use the client-side `Transport` seam — it builds `SmtpConnection`
 * values directly from raw sockets.
 */
import { Buffer } from "node:buffer";
import * as net from "node:net";
import * as tls from "node:tls";
import { Effect, Fiber, Queue, Ref, Scope } from "effect";
import { SmtpConnectionClosed, SmtpError } from "../shared/errors.ts";
import type { SmtpConnection } from "../shared/transport/index.ts";
import {
  handleConnection,
  type HandleConnectionOptions,
  type ServerSessionOptions,
} from "./session.ts";

interface ConnectionState {
  readonly incomingLines: Queue.Queue<string>;
  readonly closed: Ref.Ref<boolean>;
}

const SOCKET_KEY = Symbol.for("effect-smtp/node-server/socket");

const buildConnectionFromSocket = (
  socket: net.Socket | tls.TLSSocket,
  state: ConnectionState,
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
  const close = (): void => {
    Effect.runSync(Ref.set(state.closed, true));
    Queue.offerUnsafe(state.incomingLines, "");
  };
  socket.on("close", close);
  socket.on("error", close);

  const stripCRLF = (line: string): string =>
    line.endsWith("\r\n") ? line.slice(0, -2) : line;

  const conn: SmtpConnection & {
    [k: symbol]: net.Socket | tls.TLSSocket | undefined;
  } = {
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
        yield* Effect.sync(() => socket.write(`${line}\r\n`));
      }),
    close: Effect.sync(() => socket.end()),
  };
  conn[SOCKET_KEY] = socket;
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
          const newIncoming = Effect.runSync(Queue.unbounded<string>());
          const newClosed = Ref.makeUnsafe(false);
          const wrapped = buildConnectionFromSocket(tlsSocket, {
            incomingLines: newIncoming,
            closed: newClosed,
          });
          (wrapped as unknown as { [SOCKET_KEY]: tls.TLSSocket })[SOCKET_KEY] =
            tlsSocket;
          resume(Effect.succeed(wrapped));
        });
      });

    server.on("connection", (socket: net.Socket) => {
      connectionCounter += 1;
      const id = `c${connectionCounter}`;
      const incoming = Effect.runSync(Queue.unbounded<string>());
      const closed = Ref.makeUnsafe(false);
      const conn = buildConnectionFromSocket(socket, {
        incomingLines: incoming,
        closed,
      });

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
