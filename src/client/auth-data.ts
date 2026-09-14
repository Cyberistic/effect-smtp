import { Effect } from "effect";
import { encodeBase64 } from "../shared/internal/base64.ts";
import { quotedPrintableEncode } from "../shared/internal/quoted-printable.ts";
import { SmtpAuthError, SmtpError } from "../shared/errors.ts";
import type { SmtpConnection } from "../shared/transport/index.ts";
import { expectReply, writeCommand } from "./effects.ts";

const toBase64 = (s: string): string => encodeBase64(s);

/**
 * Send AUTH PLAIN. RFC 4954: client may include the initial response in
 * the AUTH command line, or wait for a 334 challenge.
 */
export const authPlain = (
  conn: SmtpConnection,
  identity: string,
  password: string,
): Effect.Effect<void, SmtpAuthError | SmtpError> =>
  Effect.gen(function* () {
    const token = toBase64(`\0${identity}\0${password}`);
    yield* writeCommand(conn, `AUTH PLAIN ${token}`, "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    const reply = yield* expectReply(conn, "2", "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    if (reply.code !== 235) {
      return yield* Effect.fail(
        new SmtpAuthError({ response: `${reply.code} ${reply.text}` }),
      );
    }
  });

/**
 * Send AUTH LOGIN (two-step). RFC 4954 §4: server returns 334 with
 * base64("Username:"); we reply with base64(identity); server returns
 * 334 with base64("Password:"); we reply with base64(password).
 */
export const authLogin = (
  conn: SmtpConnection,
  identity: string,
  password: string,
): Effect.Effect<void, SmtpAuthError | SmtpError> =>
  Effect.gen(function* () {
    yield* writeCommand(conn, "AUTH LOGIN", "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    const c1 = yield* expectReply(conn, "3", "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    if (c1.code !== 334) {
      return yield* Effect.fail(
        new SmtpAuthError({ response: `${c1.code} ${c1.text}` }),
      );
    }
    yield* writeCommand(conn, toBase64(identity), "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    const c2 = yield* expectReply(conn, "3", "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    if (c2.code !== 334) {
      return yield* Effect.fail(
        new SmtpAuthError({ response: `${c2.code} ${c2.text}` }),
      );
    }
    yield* writeCommand(conn, toBase64(password), "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    const done = yield* expectReply(conn, "2", "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    if (done.code !== 235) {
      return yield* Effect.fail(
        new SmtpAuthError({ response: `${done.code} ${done.text}` }),
      );
    }
  });

/**
 * Send AUTH XOAUTH2. Per Google's XOAUTH2 extension: token is the SASL
 * initial response `user=<u>\x01auth=Bearer <t>\x01\x01` base64-encoded.
 */
export const authXOauth2 = (
  conn: SmtpConnection,
  identity: string,
  token: string,
): Effect.Effect<void, SmtpAuthError | SmtpError> =>
  Effect.gen(function* () {
    const init = `user=${identity}\x01auth=Bearer ${token}\x01\x01`;
    yield* writeCommand(conn, `AUTH XOAUTH2 ${toBase64(init)}`, "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    const reply = yield* expectReply(conn, "2", "auth").pipe(
      Effect.mapError((e) => new SmtpAuthError({ response: e.message })),
    );
    if (reply.code !== 235) {
      return yield* Effect.fail(
        new SmtpAuthError({ response: `${reply.code} ${reply.text}` }),
      );
    }
  });

/**
 * STARTTLS: send the command, expect 220, then upgrade the underlying
 * Transport. Returns the upgraded connection.
 */
export const startTls = (
  conn: SmtpConnection,
  transport: {
    readonly upgradeTls: (
      c: SmtpConnection,
    ) => Effect.Effect<SmtpConnection, unknown, never>;
  },
): Effect.Effect<SmtpConnection, SmtpError> =>
  Effect.gen(function* () {
    yield* writeCommand(conn, "STARTTLS", "starttls").pipe(
      Effect.mapError(
        (e) =>
          new SmtpError({
            kind: "starttls",
            message: e.message,
            cause: e,
          }),
      ),
    );
    const reply = yield* expectReply(conn, "2", "starttls");
    if (reply.code !== 220) {
      return yield* Effect.fail(
        new SmtpError({
          kind: "starttls",
          message: `effect-smtp: STARTTLS got ${reply.code}: ${reply.text}`,
        }),
      );
    }
    return yield* transport.upgradeTls(conn) as Effect.Effect<
      SmtpConnection,
      SmtpError
    >;
  });

/**
 * RFC 5322 §3.6 mail body. We dot-stuff every leading "." per RFC 5321
 * §4.5.2, then send `<CRLF>.<CRLF>` to terminate. The body is encoded
 * with quoted-printable (RFC 2045 §6.7) for safety.
 */
export const sendDataBody = (
  conn: SmtpConnection,
  body: string,
): Effect.Effect<void, SmtpError> =>
  Effect.gen(function* () {
    const encoded = quotedPrintableEncode(body);
    const lines = encoded.split("\r\n");
    for (const line of lines) {
      let outgoing = line;
      if (outgoing.startsWith(".")) {
        outgoing = `.${outgoing}`;
      }
      yield* writeCommand(conn, outgoing, "data");
    }
    yield* writeCommand(conn, ".", "data");
  });

export const expectClass = (
  conn: SmtpConnection,
  expectedClass: "2" | "3" | "4" | "5",
  during: string,
): Effect.Effect<string, SmtpError> =>
  Effect.map(expectReply(conn, expectedClass, during), (r) => r.text);
