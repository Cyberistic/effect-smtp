import { Effect } from "effect";
import { SmtpError, SmtpGreetingError } from "../shared/errors.ts";
import { readReply, type SmtpReply } from "../shared/response.ts";
import {
  parseEhlo,
  type EhloResponse,
  type SmtpConnection,
  type Transport,
} from "../shared/transport/index.ts";

/**
 * Open a connection and read the greeting. Returns the connection on
 * a 220 greeting. Non-220 greeting fails with `SmtpGreetingError`;
 * transport failures fail with `SmtpError`.
 */
export const connectSmtp = (
  transport: Transport,
  host: string,
  port: number,
  timeoutMs?: number,
): Effect.Effect<SmtpConnection, SmtpError | SmtpGreetingError> =>
  Effect.gen(function* () {
    const opts =
      timeoutMs !== undefined ? { host, port, timeoutMs } : { host, port };
    const conn = yield* transport.connect(opts).pipe(
      Effect.mapError(
        (e) =>
          new SmtpError({
            kind: "greeting",
            message: `effect-smtp: connect failed: ${e.message}`,
            cause: e,
          }),
      ),
    );
    const reply = yield* readReply(conn.readLine).pipe(
      Effect.mapError(
        (e) =>
          new SmtpError({
            kind: "greeting",
            message: `effect-smtp: greeting read failed: ${e._tag}`,
            cause: e,
          }),
      ),
    );
    if (reply.code !== 220) {
      yield* Effect.fail(
        new SmtpGreetingError({ raw: `${reply.code} ${reply.text}` }),
      );
    }
    return conn;
  });

/**
 * Send EHLO (or HELO if `enhanced` is false) and parse the multi-line
 * response.
 */
export const ehlo = (
  conn: SmtpConnection,
  domain: string,
  options: { readonly enhanced?: boolean } = {},
): Effect.Effect<EhloResponse, SmtpError> =>
  Effect.gen(function* () {
    const verb = options.enhanced === false ? "HELO" : "EHLO";
    yield* conn.writeLine(`${verb} ${domain}`).pipe(
      Effect.mapError(
        (e) =>
          new SmtpError({
            kind: "ehlo",
            message: `effect-smtp: ${verb} write failed: ${e._tag}`,
            cause: e,
          }),
      ),
    );
    const lines: string[] = [];
    while (true) {
      const line = yield* conn.readLine.pipe(
        Effect.mapError(
          (e) =>
            new SmtpError({
              kind: "ehlo",
              message: `effect-smtp: ${verb} read failed: ${e._tag}`,
              cause: e,
            }),
        ),
      );
      lines.push(line);
      if (line.charAt(3) === " ") break;
    }
    const code = Number.parseInt(lines[0]?.slice(0, 3) ?? "0", 10);
    if (code !== 250) {
      return yield* Effect.fail(
        new SmtpError({
          kind: "ehlo",
          message: `effect-smtp: ${verb} got ${code}: ${lines.join(" | ")}`,
        }),
      );
    }
    return parseEhlo(lines);
  });

/**
 * Wait for a single SMTP reply and assert the expected class prefix.
 * `expectedClass` is the leading digit (e.g. "2", "3").
 */
export const expectReply = (
  conn: SmtpConnection,
  expectedClass: "2" | "3" | "4" | "5",
  during: string,
): Effect.Effect<SmtpReply, SmtpError> =>
  Effect.gen(function* () {
    const reply = yield* readReply(conn.readLine).pipe(
      Effect.mapError(
        (e) =>
          new SmtpError({
            kind: during,
            message: `effect-smtp: ${during} read failed: ${e._tag}`,
            cause: e,
          }),
      ),
    );
    const cls = String(reply.code).charAt(0);
    if (cls !== expectedClass) {
      return yield* Effect.fail(
        new SmtpError({
          kind: during,
          message: `effect-smtp: ${during} got ${reply.code}: ${reply.text}`,
        }),
      );
    }
    return reply;
  });

export const writeCommand = (
  conn: SmtpConnection,
  command: string,
  during: string,
): Effect.Effect<void, SmtpError> =>
  conn.writeLine(command).pipe(
    Effect.mapError(
      (e) =>
        new SmtpError({
          kind: during,
          message: `effect-smtp: ${during} write failed: ${e._tag}`,
          cause: e,
        }),
    ),
  );
