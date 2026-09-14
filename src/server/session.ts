import { Effect, Ref } from "effect";
import { SmtpAuthError, SmtpError, SmtpRejectError } from "../shared/errors.ts";
import { decodeBase64 } from "../shared/internal/base64.ts";
import { DataParser } from "../shared/internal/data-parser.ts";
import type { SmtpAddress } from "../shared/envelope.ts";
import type { SmtpConnection } from "../shared/transport/index.ts";
import { hostname } from "node:os";

const localhost = (): string => {
  try {
    return hostname();
  } catch {
    return "localhost";
  }
};

export interface ServerSessionOptions {
  readonly name: string;
  readonly banner: string;
  readonly lmtp: boolean;
  readonly authMethods: ReadonlyArray<
    "PLAIN" | "LOGIN" | "CRAM-MD5" | "XOAUTH2"
  >;
  readonly maxSize: number;
  readonly socketTimeoutMs: number;
  readonly onAuth:
    | ((
        auth: AuthObject,
        session: ServerSession,
      ) => Effect.Effect<{ readonly user: unknown } | undefined, SmtpAuthError>)
    | undefined;
  readonly onMailFrom:
    | ((
        address: SmtpAddress,
        session: ServerSession,
      ) => Effect.Effect<void, SmtpRejectError>)
    | undefined;
  readonly onRcptTo:
    | ((
        address: SmtpAddress,
        session: ServerSession,
      ) => Effect.Effect<void, SmtpRejectError>)
    | undefined;
  readonly onData: (
    stream: DataStream,
    session: ServerSession,
  ) => Effect.Effect<void, SmtpRejectError>;
  readonly onClose:
    | ((session: ServerSession) => Effect.Effect<void, never>)
    | undefined;
}

export interface AuthObject {
  readonly method: "PLAIN" | "LOGIN" | "CRAM-MD5" | "XOAUTH2";
  readonly identity: string;
  readonly password?: string;
  readonly token?: string;
}

export interface DataStream {
  readonly lines: Effect.Effect<ReadonlyArray<string>, never>;
  readonly byteLength: Effect.Effect<number, never>;
  readonly sizeExceeded: Effect.Effect<boolean, never>;
}

export interface ServerSession {
  readonly id: string;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly localAddress: string;
  readonly localPort: number;
  readonly clientHostname: string;
  readonly openingCommand: string;
  readonly secure: boolean;
  readonly envelope: {
    readonly mailFrom: SmtpAddress | undefined;
    readonly rcptTo: ReadonlyArray<SmtpAddress>;
  };
  readonly authenticated: boolean;
  readonly user: unknown;
}

const parseAddressCommand = (
  name: string,
  command: string,
): SmtpAddress | null => {
  const colonIdx = command.indexOf(":");
  if (colonIdx === -1) return null;
  const prefix = command.slice(0, colonIdx).trim().toUpperCase();
  if (prefix !== name) return null;
  const rest = command.slice(colonIdx + 1).trim();
  const parts = rest.split(/\s+/);
  const raw = parts.shift() ?? "";
  const m = /^<([^>]*)>$/.exec(raw);
  if (!m) return null;
  const address = m[1] ?? "";
  const args: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    args[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return Object.keys(args).length > 0 ? { address, args } : { address };
};

const sendReply = (
  conn: SmtpConnection,
  code: number,
  text: string,
  options?: { readonly continuation?: boolean },
): Effect.Effect<void, SmtpError> =>
  conn.writeLine(`${code}${options?.continuation ? "-" : " "}${text}`).pipe(
    Effect.mapError(
      (e) =>
        new SmtpError({
          kind: "sendReply",
          message: `effect-smtp: sendReply failed: ${e._tag}`,
          cause: e,
        }),
    ),
  );

const sendMulti = (
  conn: SmtpConnection,
  code: number,
  lines: ReadonlyArray<string>,
): Effect.Effect<void, SmtpError> =>
  Effect.gen(function* () {
    for (let i = 0; i < lines.length - 1; i++) {
      yield* sendReply(conn, code, lines[i] ?? "", { continuation: true });
    }
    yield* sendReply(conn, code, lines[lines.length - 1] ?? "");
  });

const ehloCapabilities = (
  options: ServerSessionOptions,
  tlsAvailable: boolean,
): ReadonlyArray<string> => {
  const lines: string[] = [];
  if (tlsAvailable && !options.lmtp) lines.push("STARTTLS");
  if (options.authMethods.length > 0) {
    lines.push(`AUTH ${options.authMethods.join(" ")}`);
  }
  if (options.maxSize > 0) lines.push(`SIZE ${options.maxSize}`);
  if (!options.lmtp) {
    lines.push("8BITMIME", "PIPELINING", "ENHANCEDSTATUSCODES");
  } else {
    lines.push("PIPELINING", "ENHANCEDSTATUSCODES");
  }
  return lines;
};

interface SessionState {
  readonly openingCommand: string;
  readonly clientHostname: string;
  readonly secure: boolean;
  readonly mailFrom: SmtpAddress | undefined;
  readonly rcptTo: ReadonlyArray<SmtpAddress>;
  readonly user: unknown;
}

const initialState = (): SessionState => ({
  openingCommand: "",
  clientHostname: "unknown",
  secure: false,
  mailFrom: undefined,
  rcptTo: [],
  user: undefined,
});

const buildSession = (
  id: string,
  remoteAddress: string,
  remotePort: number,
  localAddress: string,
  localPort: number,
  state: SessionState,
): ServerSession => ({
  id,
  remoteAddress,
  remotePort,
  localAddress,
  localPort,
  clientHostname: state.clientHostname,
  openingCommand: state.openingCommand,
  secure: state.secure,
  envelope: { mailFrom: state.mailFrom, rcptTo: state.rcptTo },
  authenticated: state.user !== undefined,
  user: state.user,
});

export interface HandleConnectionOptions {
  readonly conn: SmtpConnection;
  readonly sessionOptions: ServerSessionOptions;
  readonly id: string;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly localAddress: string;
  readonly localPort: number;
  readonly upgradeTls: (
    conn: SmtpConnection,
  ) => Effect.Effect<SmtpConnection, SmtpError>;
  readonly tlsAvailable: boolean;
}

export const handleConnection = (
  opts: HandleConnectionOptions,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const {
      conn,
      sessionOptions,
      id,
      remoteAddress,
      remotePort,
      localAddress,
      localPort,
      upgradeTls,
      tlsAvailable,
    } = opts;
    const stateRef = yield* Ref.make<SessionState>(initialState());
    let currentConn: SmtpConnection = conn;

    const banner =
      sessionOptions.banner !== "" ? ` ${sessionOptions.banner}` : "";
    yield* sendReply(
      currentConn,
      220,
      `${sessionOptions.name} ESMTP ready${banner}`,
    );

    let running = true;
    while (running) {
      const lineResult = yield* Effect.matchEffect(currentConn.readLine, {
        onFailure: () => Effect.succeed(null),
        onSuccess: (line) => Effect.succeed(line),
      });
      if (lineResult === null) break;
      const line = lineResult;
      const verb = line.split(" ")[0]?.toUpperCase() ?? "";

      if (verb === "EHLO" || verb === "LHLO") {
        const hostnameArg = line.split(" ")[1] ?? "unknown";
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          openingCommand: verb,
          clientHostname: hostnameArg,
        }));
        const caps = ehloCapabilities(sessionOptions, tlsAvailable);
        yield* sendMulti(currentConn, 250, [sessionOptions.name, ...caps]);
      } else if (verb === "HELO") {
        const hostnameArg = line.split(" ")[1] ?? "unknown";
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          openingCommand: "HELO",
          clientHostname: hostnameArg,
        }));
        yield* sendReply(currentConn, 250, sessionOptions.name);
      } else if (verb === "STARTTLS" && tlsAvailable) {
        yield* sendReply(currentConn, 220, "Begin TLS negotiation now");
        const upgraded = yield* Effect.matchEffect(upgradeTls(currentConn), {
          onFailure: () => Effect.succeed(null as SmtpConnection | null),
          onSuccess: (c) => Effect.succeed(c as SmtpConnection | null),
        });
        if (upgraded) {
          currentConn = upgraded;
          yield* Ref.update(stateRef, (s) => ({ ...s, secure: true }));
        }
      } else if (verb === "AUTH") {
        const rest = line.slice(5);
        const parts = rest.split(" ");
        const method = parts[0];
        if (
          method !== "PLAIN" &&
          method !== "LOGIN" &&
          method !== "CRAM-MD5" &&
          method !== "XOAUTH2"
        ) {
          yield* sendReply(
            currentConn,
            504,
            "Authentication mechanism not supported",
          );
          continue;
        }
        if (!sessionOptions.authMethods.includes(method)) {
          yield* sendReply(
            currentConn,
            504,
            "Authentication mechanism not supported",
          );
          continue;
        }
        if (method === "PLAIN") {
          const token = parts.slice(1).join(" ");
          if (token === "") {
            yield* sendReply(currentConn, 334, "");
            const reply = yield* currentConn.readLine.pipe(
              Effect.mapError(
                (e) =>
                  new SmtpError({
                    kind: "auth",
                    message: e._tag,
                    cause: e,
                  }),
              ),
            );
            yield* runAuthPlain(
              currentConn,
              sessionOptions,
              reply,
              stateRef,
              buildSession(
                id,
                remoteAddress,
                remotePort,
                localAddress,
                localPort,
                initialState(),
              ),
            );
          } else {
            yield* runAuthPlain(
              currentConn,
              sessionOptions,
              token,
              stateRef,
              buildSession(
                id,
                remoteAddress,
                remotePort,
                localAddress,
                localPort,
                initialState(),
              ),
            );
          }
        } else if (method === "LOGIN") {
          yield* sendReply(currentConn, 334, "VXNlcm5hbWU6");
          const userLine = yield* currentConn.readLine.pipe(
            Effect.mapError(
              (e) =>
                new SmtpError({
                  kind: "auth",
                  message: e._tag,
                  cause: e,
                }),
            ),
          );
          const username = new TextDecoder().decode(decodeBase64(userLine));
          yield* sendReply(currentConn, 334, "UGFzc3dvcmQ6");
          const passLine = yield* currentConn.readLine.pipe(
            Effect.mapError(
              (e) =>
                new SmtpError({
                  kind: "auth",
                  message: e._tag,
                  cause: e,
                }),
            ),
          );
          const password = new TextDecoder().decode(decodeBase64(passLine));
          yield* runAuthCredential(
            currentConn,
            sessionOptions,
            { method: "LOGIN", identity: username, password },
            stateRef,
            buildSession(
              id,
              remoteAddress,
              remotePort,
              localAddress,
              localPort,
              initialState(),
            ),
          );
        } else {
          yield* sendReply(
            currentConn,
            504,
            `Method ${method} not yet implemented on server`,
          );
        }
      } else if (verb === "MAIL") {
        const fromCmd = parseAddressCommand("MAIL FROM", line);
        if (!fromCmd) {
          yield* sendReply(currentConn, 501, "Syntax: MAIL FROM:<address>");
          continue;
        }
        const s = yield* Ref.get(stateRef);
        if (sessionOptions.onMailFrom) {
          const result = yield* Effect.matchEffect(
            sessionOptions.onMailFrom(
              fromCmd,
              buildSession(
                id,
                remoteAddress,
                remotePort,
                localAddress,
                localPort,
                s,
              ),
            ),
            {
              onFailure: (e) =>
                Effect.succeed({ ok: false as const, error: e }),
              onSuccess: () => Effect.succeed({ ok: true as const }),
            },
          );
          if (!result.ok) {
            yield* sendReply(
              currentConn,
              result.error.code,
              result.error.message,
            );
            continue;
          }
        }
        yield* Ref.update(stateRef, (st) => ({
          ...st,
          mailFrom: fromCmd,
          rcptTo: [],
        }));
        yield* sendReply(currentConn, 250, "2.1.0 Sender OK");
      } else if (verb === "RCPT") {
        const toCmd = parseAddressCommand("RCPT TO", line);
        if (!toCmd) {
          yield* sendReply(currentConn, 501, "Syntax: RCPT TO:<address>");
          continue;
        }
        const s = yield* Ref.get(stateRef);
        if (!s.mailFrom) {
          yield* sendReply(currentConn, 503, "Need MAIL before RCPT");
          continue;
        }
        if (sessionOptions.onRcptTo) {
          const result = yield* Effect.matchEffect(
            sessionOptions.onRcptTo(
              toCmd,
              buildSession(
                id,
                remoteAddress,
                remotePort,
                localAddress,
                localPort,
                s,
              ),
            ),
            {
              onFailure: (e) =>
                Effect.succeed({ ok: false as const, error: e }),
              onSuccess: () => Effect.succeed({ ok: true as const }),
            },
          );
          if (!result.ok) {
            yield* sendReply(
              currentConn,
              result.error.code,
              result.error.message,
            );
            continue;
          }
        }
        yield* Ref.update(stateRef, (st) => ({
          ...st,
          rcptTo: [...st.rcptTo, toCmd],
        }));
        yield* sendReply(currentConn, 250, "2.1.5 Recipient OK");
      } else if (verb === "DATA") {
        const s = yield* Ref.get(stateRef);
        if (!s.mailFrom || s.rcptTo.length === 0) {
          yield* sendReply(currentConn, 503, "Need MAIL and RCPT before DATA");
          continue;
        }
        yield* sendReply(currentConn, 354, "End data with <CR><LF>.<CR><LF>");
        const parsed = yield* readDataMode(currentConn, sessionOptions.maxSize);
        const byteLength = parsed.byteLength;
        const sizeExceeded =
          sessionOptions.maxSize > 0 && byteLength > sessionOptions.maxSize;
        if (sizeExceeded) {
          yield* sendReply(
            currentConn,
            552,
            `Message exceeds size limit of ${sessionOptions.maxSize}`,
          );
          continue;
        }
        const dataStream: DataStream = {
          lines: Effect.succeed(parsed.lines),
          byteLength: Effect.succeed(byteLength),
          sizeExceeded: Effect.succeed(false),
        };
        const result = yield* Effect.matchEffect(
          sessionOptions.onData(
            dataStream,
            buildSession(
              id,
              remoteAddress,
              remotePort,
              localAddress,
              localPort,
              s,
            ),
          ),
          {
            onFailure: (e) => Effect.succeed({ ok: false as const, error: e }),
            onSuccess: () => Effect.succeed({ ok: true as const }),
          },
        );
        if (!result.ok) {
          yield* sendReply(
            currentConn,
            result.error.code,
            result.error.message,
          );
          continue;
        }
        yield* sendReply(currentConn, 250, "2.6.0 Message accepted");
        yield* Ref.update(stateRef, (st) => ({
          ...st,
          mailFrom: undefined,
          rcptTo: [],
        }));
      } else if (verb === "RSET") {
        yield* Ref.update(stateRef, (st) => ({
          ...st,
          mailFrom: undefined,
          rcptTo: [],
        }));
        yield* sendReply(currentConn, 250, "OK");
      } else if (verb === "NOOP") {
        yield* sendReply(currentConn, 250, "OK");
      } else if (verb === "QUIT") {
        yield* sendReply(currentConn, 221, "Bye");
        running = false;
      } else {
        yield* sendReply(currentConn, 500, "Command not recognized");
      }
    }

    if (sessionOptions.onClose) {
      const s = yield* Ref.get(stateRef);
      yield* sessionOptions.onClose(
        buildSession(id, remoteAddress, remotePort, localAddress, localPort, s),
      );
    }

    yield* currentConn.close;
  }).pipe(Effect.orElseSucceed(() => undefined));

const runAuthPlain = (
  conn: SmtpConnection,
  options: ServerSessionOptions,
  token: string,
  stateRef: Ref.Ref<SessionState>,
  session: ServerSession,
): Effect.Effect<void, never> => {
  const decoded = new TextDecoder().decode(decodeBase64(token));
  const parts = decoded.split("\0");
  const identity = parts[1] || parts[0] || "";
  const password = parts[2] || "";
  return runAuthCredential(
    conn,
    options,
    { method: "PLAIN", identity, password },
    stateRef,
    session,
  );
};

const runAuthCredential = (
  conn: SmtpConnection,
  options: ServerSessionOptions,
  auth: AuthObject,
  stateRef: Ref.Ref<SessionState>,
  session: ServerSession,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (!options.onAuth) {
      yield* sendReply(conn, 535, "5.7.8 Authentication credentials invalid");
      return;
    }
    const result = yield* Effect.matchEffect(options.onAuth(auth, session), {
      onFailure: (e) => Effect.succeed({ ok: false as const, error: e }),
      onSuccess: (v) => Effect.succeed({ ok: true as const, value: v }),
    });
    if (!result.ok || !result.value?.user) {
      yield* sendReply(conn, 535, "5.7.8 Authentication credentials invalid");
      return;
    }
    yield* Ref.update(stateRef, (s) => ({ ...s, user: result.value?.user }));
    yield* sendReply(conn, 235, "2.7.0 Authentication successful");
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Read the DATA body. Consumes raw chunks via
 * `SmtpConnection.readChunk` — the `DataParser` is chunk-native, so a
 * 1 MB body is a handful of reads rather than ~13k line reads.
 */
const readDataMode = (
  conn: SmtpConnection,
  maxBytes: number,
): Effect.Effect<
  { readonly lines: ReadonlyArray<string>; readonly byteLength: number },
  SmtpError
> =>
  Effect.gen(function* () {
    const parser = new DataParser(maxBytes);
    const collected: string[] = [];
    while (!parser.finished) {
      const chunk = yield* conn.readChunk.pipe(
        Effect.mapError(
          (e) =>
            new SmtpError({
              kind: "data",
              message: `effect-smtp: DATA read failed: ${e._tag}`,
              cause: e,
            }),
        ),
      );
      const { lines } = parser.feed(Buffer.from(chunk));
      for (const parsed of lines) {
        collected.push(parsed);
      }
    }
    return { lines: collected, byteLength: parser.bytes };
  });

// Reserved for future server-side LMTP / CRAM-MD5.
void localhost;
