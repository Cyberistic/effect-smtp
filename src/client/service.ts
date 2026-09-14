import { Context, Effect, Layer } from "effect";
import {
  SmtpAuthError,
  SmtpConnectionClosed,
  SmtpError,
  SmtpGreetingError,
} from "../shared/errors.ts";
import type { SmtpConnection, Transport } from "../shared/transport/index.ts";
import type { MakeSmtpClientOptions, SendRequest } from "../shared/envelope.ts";
import {
  authLogin,
  authPlain,
  authXOauth2,
  expectClass,
  sendDataBody,
  startTls,
} from "./auth-data.ts";
import { connectSmtp, ehlo, expectReply, writeCommand } from "./effects.ts";

interface SmtpClientShape {
  readonly sendEmail: (
    request: SendRequest,
  ) => Effect.Effect<
    { readonly messageId: string },
    SmtpError | SmtpAuthError | SmtpConnectionClosed
  >;
  readonly close: Effect.Effect<void, never>;
  readonly runWithConnection: <A, E>(
    body: (conn: SmtpConnection) => Effect.Effect<A, E | SmtpError>,
  ) => Effect.Effect<A, E | SmtpError>;
}

export class SmtpClient extends Context.Service<SmtpClient, SmtpClientShape>()(
  "effect-smtp/SmtpClient",
) {}

const hostname = (): string => {
  try {
    return globalThis.process?.env?.["HOSTNAME"] ?? "localhost";
  } catch {
    return "localhost";
  }
};

const formatAddress = (addr: {
  readonly email: string;
  readonly name?: string;
}): string =>
  addr.name
    ? `"${addr.name.replace(/"/g, '\\"')}" <${addr.email}>`
    : `<${addr.email}>`;

const buildHeaders = (
  request: SendRequest,
  messageId: string,
): ReadonlyArray<string> => {
  const date = new Date().toUTCString();
  const lines: string[] = [
    `Date: ${date}`,
    `From: ${formatAddress(request.from)}`,
    `To: ${request.to.map(formatAddress).join(", ")}`,
  ];
  if (request.cc && request.cc.length > 0) {
    lines.push(`Cc: ${request.cc.map(formatAddress).join(", ")}`);
  }
  lines.push(
    `Subject: ${request.subject}`,
    `Message-ID: <${messageId}>`,
    `MIME-Version: 1.0`,
  );
  if (request.text && request.html) {
    lines.push(
      `Content-Type: multipart/alternative; boundary="effect-smtp-boundary"`,
    );
  } else if (request.html) {
    lines.push(`Content-Type: text/html; charset=utf-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
  } else {
    lines.push(`Content-Type: text/plain; charset=utf-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
  }
  if (request.headers) {
    for (const [k, v] of Object.entries(request.headers)) {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines;
};

const buildBody = (request: SendRequest): string => {
  if (request.text && request.html) {
    const b = "effect-smtp-boundary";
    return [
      `--${b}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      request.text,
      ``,
      `--${b}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      request.html,
      ``,
      `--${b}--`,
    ].join("\r\n");
  }
  return request.html ?? request.text ?? "";
};

export const makeSmtpClient = (
  transport: Transport,
  options: MakeSmtpClientOptions,
): Layer.Layer<
  SmtpClient,
  SmtpError | SmtpAuthError | SmtpGreetingError,
  never
> =>
  Layer.effect(
    SmtpClient,
    Effect.gen(function* () {
      const conn = yield* connectSmtp(
        transport,
        options.host,
        options.port ?? 587,
        options.timeoutMs,
      );

      const greetingEhlo = yield* ehlo(conn, hostname());

      let working: SmtpConnection = conn;
      const wantStarttls =
        options.tls?.starttls !== false &&
        greetingEhlo.extensions.some((e) => e.keyword === "STARTTLS");
      if (wantStarttls) {
        working = yield* startTls(conn, transport);
        yield* ehlo(working, hostname());
      }

      if (options.auth) {
        switch (options.auth.method) {
          case "PLAIN":
            yield* authPlain(
              working,
              options.auth.identity,
              options.auth.password,
            );
            break;
          case "LOGIN":
            yield* authLogin(
              working,
              options.auth.identity,
              options.auth.password,
            );
            break;
          case "XOAUTH2":
            yield* authXOauth2(
              working,
              options.auth.identity,
              options.auth.token,
            );
            break;
        }
      }

      const sendEmail: SmtpClientShape["sendEmail"] = (request) =>
        Effect.gen(function* () {
          const messageId = `${Date.now()}.${Math.random().toString(36).slice(2)}@${options.host}`;
          yield* writeCommand(
            working,
            `MAIL FROM:<${request.from.email}>`,
            "mail",
          );
          yield* expectClass(working, "2", "mail");
          for (const r of [
            ...request.to,
            ...(request.cc ?? []),
            ...(request.bcc ?? []),
          ]) {
            yield* writeCommand(working, `RCPT TO:<${r.email}>`, "rcpt");
            yield* expectClass(working, "2", "rcpt");
          }
          yield* writeCommand(working, "DATA", "data");
          yield* expectClass(working, "3", "data");
          const headers = buildHeaders(request, messageId);
          for (const h of headers) {
            yield* writeCommand(working, h, "data");
          }
          yield* writeCommand(working, "", "data");
          yield* sendDataBody(working, buildBody(request));
          const ok = yield* expectReply(working, "2", "data");
          return { messageId: ok.text };
        });

      const runWithConnection: SmtpClientShape["runWithConnection"] = (body) =>
        body(working);

      return SmtpClient.of({
        sendEmail,
        close: working.close,
        runWithConnection,
      });
    }),
  );

// Re-export the type for callers that want to type-narrow on the
// runtime service's shape without importing Context.
export type { SmtpClientShape };

// Mark optional fields unused to suppress noUnusedLocals when narrowed
const _mark: SmtpGreetingError | SmtpConnectionClosed = undefined as never;
void _mark;
