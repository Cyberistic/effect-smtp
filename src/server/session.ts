import { Effect } from "effect";
import { SmtpAuthError, SmtpError, SmtpRejectError } from "../shared/errors.ts";
import { parseAddressCommand } from "../shared/internal/address.ts";
import { decodeBase64 } from "../shared/internal/base64.ts";
import {
  DataParser,
  joinBody,
  splitLines,
} from "../shared/internal/data-parser.ts";
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
  /** When false, MAIL/RCPT/DATA require a successful AUTH (bun-smtp parity). */
  readonly authOptional: boolean;
  readonly maxSize: number;
  readonly socketTimeoutMs: number;
  readonly onConnect:
    | ((session: ServerSession) => Effect.Effect<void, SmtpRejectError>)
    | undefined;
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
  /**
   * The body's lines, decoded to UTF-8. Lazy — a handler that only
   * drains the message should read {@link bytes} instead, so it never
   * pays for per-line string allocation.
   */
  readonly lines: Effect.Effect<ReadonlyArray<string>, never>;
  /** The raw dot-unstuffed body (lines joined by CRLF), undecoded. */
  readonly bytes: Effect.Effect<Uint8Array, never>;
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
  /**
   * SMTP-family transmission label, grown as the session does:
   * `SMTP` → `ESMTP` after EHLO → `ESMTPS` once secured → `ESMTPSA`
   * once authenticated. LMTP variants use the `L` prefix.
   */
  readonly transmissionType: string;
  /** 1 for the first completed DATA, incrementing thereafter. */
  readonly transaction: number;
}

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
  readonly transaction: number;
}

const initialState = (): SessionState => ({
  openingCommand: "",
  clientHostname: "unknown",
  secure: false,
  mailFrom: undefined,
  rcptTo: [],
  user: undefined,
  transaction: 0,
});

/** An HTTP request line hitting an SMTP port (RFC 5321 §4.2.1 note). */
const isHttpRequest = (line: string): boolean =>
  /^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH|TRACE|CONNECT) \S+ HTTP\//.test(
    line,
  );

/** True when `MAIL FROM:… SIZE=n` declares more than the configured limit. */
const exceedsDeclaredSize = (
  address: SmtpAddress,
  maxSize: number,
): boolean => {
  if (maxSize <= 0) return false;
  const declared = address.args?.["SIZE"];
  if (typeof declared !== "string") return false;
  const n = Number.parseInt(declared, 10);
  return Number.isFinite(n) && n > maxSize;
};

/** RFC 5322-family transmission label, grown as the session progresses. */
const transmissionType = (state: SessionState, lmtp: boolean): string => {
  let type = lmtp ? "LMTP" : "SMTP";
  if (state.openingCommand === "EHLO" || state.openingCommand === "LHLO") {
    type = `E${type}`;
  }
  if (state.secure) type += "S";
  if (state.user !== undefined) type += "A";
  return type;
};

const buildSession = (
  id: string,
  remoteAddress: string,
  remotePort: number,
  localAddress: string,
  localPort: number,
  state: SessionState,
  lmtp: boolean,
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
  transmissionType: transmissionType(state, lmtp),
  transaction: state.transaction,
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
    // Per-connection state, touched by exactly one fiber, so a local is
    // safe and avoids a Ref round-trip on every command.
    let state = initialState();
    let currentConn: SmtpConnection = conn;
    const lmtp = sessionOptions.lmtp;

    const session = (state: SessionState): ServerSession =>
      buildSession(
        id,
        remoteAddress,
        remotePort,
        localAddress,
        localPort,
        state,
        lmtp,
      );

    const readLine = (): Effect.Effect<string | null, never> =>
      Effect.matchEffect(currentConn.readLine, {
        onFailure: () => Effect.succeed(null),
        onSuccess: (line) => Effect.succeed(line),
      });

    // onConnect runs before the greeting and can refuse the connection.
    if (sessionOptions.onConnect) {
      const refusal = yield* Effect.matchEffect(
        sessionOptions.onConnect(session(state)),
        {
          onFailure: (e: SmtpRejectError) => Effect.succeed(e),
          onSuccess: () => Effect.succeed(null),
        },
      );
      if (refusal) {
        yield* sendReply(currentConn, refusal.code, refusal.message);
        yield* currentConn.close;
        return;
      }
    }

    const banner =
      sessionOptions.banner !== "" ? ` ${sessionOptions.banner}` : "";
    yield* sendReply(
      currentConn,
      220,
      `${sessionOptions.name} ESMTP ready${banner}`,
    );

    let running = true;
    while (running) {
      const line = yield* readLine();
      if (line === null) break;
      const verb = line.split(" ")[0]?.toUpperCase() ?? "";
      const arg = line.slice(verb.length).trim();
      const greeted = state.openingCommand !== "";
      const authed = state.user !== undefined;

      if (verb === "EHLO" || verb === "LHLO" || verb === "HELO") {
        if (verb === "LHLO" && !lmtp) {
          yield* sendReply(currentConn, 500, "Command not recognized");
        } else if (verb === "EHLO" && lmtp) {
          yield* sendReply(currentConn, 500, "Command not recognized");
        } else if (arg === "") {
          yield* sendReply(currentConn, 501, `Syntax: ${verb} hostname`);
        } else {
          state = { ...state, openingCommand: verb, clientHostname: arg };
          if (verb === "HELO") {
            yield* sendReply(currentConn, 250, sessionOptions.name);
          } else {
            // STARTTLS is not offered once the session is already secure.
            const caps = ehloCapabilities(
              sessionOptions,
              tlsAvailable && !state.secure,
            );
            yield* sendMulti(currentConn, 250, [sessionOptions.name, ...caps]);
          }
        }
      } else if (verb === "STARTTLS") {
        if (state.secure) {
          yield* sendReply(currentConn, 503, "TLS already active");
        } else if (!tlsAvailable) {
          yield* sendReply(currentConn, 502, "STARTTLS not available");
        } else {
          yield* sendReply(currentConn, 220, "Begin TLS negotiation now");
          const upgraded = yield* Effect.matchEffect(upgradeTls(currentConn), {
            onFailure: () => Effect.succeed(null as SmtpConnection | null),
            onSuccess: (c) => Effect.succeed(c as SmtpConnection | null),
          });
          if (upgraded) {
            currentConn = upgraded;
            state = { ...state, secure: true };
          }
        }
      } else if (verb === "AUTH") {
        const parts = arg.split(" ");
        const method = parts[0] ?? "";
        if (!greeted) {
          yield* sendReply(currentConn, 503, "Send EHLO first");
        } else if (!sessionOptions.authMethods.includes(method as never)) {
          yield* sendReply(
            currentConn,
            504,
            "Authentication mechanism not supported",
          );
        } else if (method === "PLAIN") {
          const token = parts.slice(1).join(" ");
          const initial =
            token === ""
              ? yield* Effect.gen(function* () {
                  yield* sendReply(currentConn, 334, "");
                  return (yield* readLine()) ?? "";
                })
              : token;
          const user = yield* runAuthPlain(
            currentConn,
            sessionOptions,
            initial,
            session(state),
          );
          if (user !== undefined) state = { ...state, user };
        } else if (method === "LOGIN") {
          yield* sendReply(currentConn, 334, "VXNlcm5hbWU6");
          const userLine = (yield* readLine()) ?? "";
          yield* sendReply(currentConn, 334, "UGFzc3dvcmQ6");
          const passLine = (yield* readLine()) ?? "";
          const decode = (b64: string): string =>
            new TextDecoder().decode(decodeBase64(b64));
          const user = yield* runAuthCredential(
            currentConn,
            sessionOptions,
            {
              method: "LOGIN",
              identity: decode(userLine),
              password: decode(passLine),
            },
            session(state),
          );
          if (user !== undefined) state = { ...state, user };
        } else {
          yield* sendReply(
            currentConn,
            504,
            `Method ${method} not implemented on server`,
          );
        }
      } else if (verb === "MAIL") {
        const from = parseAddressCommand("MAIL FROM", line);
        if (!greeted) {
          yield* sendReply(currentConn, 503, "Send EHLO first");
        } else if (!sessionOptions.authOptional && !authed) {
          yield* sendReply(currentConn, 530, "5.7.0 Authentication required");
        } else if (state.mailFrom !== undefined) {
          yield* sendReply(currentConn, 503, "Nested MAIL command");
        } else if (!from) {
          yield* sendReply(currentConn, 501, "Syntax: MAIL FROM:<address>");
        } else if (exceedsDeclaredSize(from, sessionOptions.maxSize)) {
          yield* sendReply(
            currentConn,
            552,
            "Message size exceeds fixed limit",
          );
        } else {
          const refusal = sessionOptions.onMailFrom
            ? yield* Effect.matchEffect(
                sessionOptions.onMailFrom(from, session(state)),
                {
                  onFailure: (e: SmtpRejectError) => Effect.succeed(e),
                  onSuccess: () => Effect.succeed(null),
                },
              )
            : null;
          if (refusal) {
            yield* sendReply(currentConn, refusal.code, refusal.message);
          } else {
            // A MAIL FROM opens a transaction, so the counter advances
            // before onData sees it (1 for the first message).
            state = {
              ...state,
              mailFrom: from,
              rcptTo: [],
              transaction: state.transaction + 1,
            };
            yield* sendReply(currentConn, 250, "2.1.0 Sender OK");
          }
        }
      } else if (verb === "RCPT") {
        const to = parseAddressCommand("RCPT TO", line);
        if (!greeted) {
          yield* sendReply(currentConn, 503, "Send EHLO first");
        } else if (!sessionOptions.authOptional && !authed) {
          yield* sendReply(currentConn, 530, "5.7.0 Authentication required");
        } else if (!state.mailFrom) {
          yield* sendReply(currentConn, 503, "Need MAIL before RCPT");
        } else if (!to) {
          yield* sendReply(currentConn, 501, "Syntax: RCPT TO:<address>");
        } else if (sessionOptions.onRcptTo) {
          const refusal = yield* Effect.matchEffect(
            sessionOptions.onRcptTo(to, session(state)),
            {
              onFailure: (e: SmtpRejectError) => Effect.succeed(e),
              onSuccess: () => Effect.succeed(null),
            },
          );
          if (refusal) {
            yield* sendReply(currentConn, refusal.code, refusal.message);
          } else {
            state = { ...state, rcptTo: [...state.rcptTo, to] };
            yield* sendReply(currentConn, 250, "2.1.5 Recipient OK");
          }
        } else {
          state = { ...state, rcptTo: [...state.rcptTo, to] };
          yield* sendReply(currentConn, 250, "2.1.5 Recipient OK");
        }
      } else if (verb === "DATA") {
        if (!greeted) {
          yield* sendReply(currentConn, 503, "Send EHLO first");
        } else if (!sessionOptions.authOptional && !authed) {
          yield* sendReply(currentConn, 530, "5.7.0 Authentication required");
        } else if (!state.mailFrom || state.rcptTo.length === 0) {
          yield* sendReply(currentConn, 503, "Need MAIL and RCPT before DATA");
        } else {
          yield* sendReply(currentConn, 354, "End data with <CR><LF>.<CR><LF>");
          const parsed = yield* readDataMode(
            currentConn,
            sessionOptions.maxSize,
          );
          const byteLength = parsed.byteLength;
          if (
            sessionOptions.maxSize > 0 &&
            byteLength > sessionOptions.maxSize
          ) {
            yield* sendReply(
              currentConn,
              552,
              `Message exceeds size limit of ${sessionOptions.maxSize}`,
            );
          } else {
            const dataStream: DataStream = {
              // Both views are lazy: a handler that drains pays for
              // neither the concatenation nor the decode.
              bytes: Effect.sync(() => joinBody(parsed.body)),
              lines: Effect.sync(() => splitLines(joinBody(parsed.body))),
              byteLength: Effect.succeed(byteLength),
              sizeExceeded: Effect.succeed(false),
            };
            const refusal = yield* Effect.matchEffect(
              sessionOptions.onData(dataStream, session(state)),
              {
                onFailure: (e: SmtpRejectError) => Effect.succeed(e),
                onSuccess: () => Effect.succeed(null),
              },
            );
            if (refusal) {
              yield* sendReply(currentConn, refusal.code, refusal.message);
            } else {
              yield* sendReply(currentConn, 250, "2.6.0 Message accepted");
              state = { ...state, mailFrom: undefined, rcptTo: [] };
            }
          }
        }
      } else if (verb === "RSET") {
        state = { ...state, mailFrom: undefined, rcptTo: [] };
        yield* sendReply(currentConn, 250, "OK");
      } else if (verb === "NOOP") {
        yield* sendReply(currentConn, 250, "OK");
      } else if (verb === "VRFY") {
        yield* sendReply(currentConn, 252, "Cannot VRFY user, but will accept");
      } else if (verb === "HELP") {
        yield* sendReply(currentConn, 214, "See RFC 5321");
      } else if (verb === "QUIT") {
        yield* sendReply(currentConn, 221, "Bye");
        running = false;
      } else if (isHttpRequest(line)) {
        yield* sendReply(currentConn, 421, "This is an SMTP server");
        running = false;
      } else {
        yield* sendReply(currentConn, 500, "Command not recognized");
      }
    }

    if (sessionOptions.onClose) {
      yield* sessionOptions.onClose(session(state));
    }

    yield* currentConn.close;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Run an AUTH exchange. Sends the 235/535 reply and returns the user on
 * success, or `undefined` on failure — the caller folds it into session
 * state.
 */
const runAuthCredential = (
  conn: SmtpConnection,
  options: ServerSessionOptions,
  auth: AuthObject,
  session: ServerSession,
): Effect.Effect<unknown, never> =>
  Effect.gen(function* () {
    if (!options.onAuth) {
      yield* sendReply(conn, 535, "5.7.8 Authentication credentials invalid");
      return undefined;
    }
    const result = yield* Effect.matchEffect(options.onAuth(auth, session), {
      onFailure: (e) => Effect.succeed({ ok: false as const, error: e }),
      onSuccess: (v) => Effect.succeed({ ok: true as const, value: v }),
    });
    if (!result.ok || !result.value?.user) {
      yield* sendReply(conn, 535, "5.7.8 Authentication credentials invalid");
      return undefined;
    }
    yield* sendReply(conn, 235, "2.7.0 Authentication successful");
    return result.value.user;
  }).pipe(Effect.orElseSucceed(() => undefined));

const runAuthPlain = (
  conn: SmtpConnection,
  options: ServerSessionOptions,
  token: string,
  session: ServerSession,
): Effect.Effect<unknown, never> => {
  const parts = new TextDecoder().decode(decodeBase64(token)).split("\0");
  return runAuthCredential(
    conn,
    options,
    {
      method: "PLAIN",
      identity: parts[1] || parts[0] || "",
      password: parts[2] || "",
    },
    session,
  );
};

/**
 * Read the DATA body. Consumes raw chunks via
 * `SmtpConnection.readChunk` and keeps the parser's raw body segments —
 * a 1 MB body with no leading dots is one segment per socket chunk, not
 * ~13k line slices.
 */
const readDataMode = (
  conn: SmtpConnection,
  maxBytes: number,
): Effect.Effect<
  { readonly body: ReadonlyArray<Uint8Array>; readonly byteLength: number },
  SmtpError
> =>
  Effect.gen(function* () {
    const parser = new DataParser(maxBytes);
    const segments: Uint8Array[] = [];
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
      const { body } = parser.feed(chunk);
      for (const segment of body) segments.push(segment);
    }
    return { body: segments, byteLength: parser.bytes };
  });

// Reserved for future server-side LMTP / CRAM-MD5.
void localhost;
