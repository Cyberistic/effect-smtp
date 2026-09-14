# effect-smtp

Pure, Effect-native SMTP client and server. `Transport` is a structural
seam — anyone can implement it (a TCP client, a TLS-wrapped socket, an
in-memory test double). The library is pure; only the bundled
`node-tcp.ts` and `server.ts` ever touch the network.

## Quick start — client

```ts
import { Effect, Layer } from "effect";
import { SmtpClient, makeSmtpClient } from "effect-smtp";
import { makeNodeTcpTransport } from "effect-smtp/transport";

const program = Effect.gen(function* () {
  const client = yield* SmtpClient;
  const result = yield* client.sendEmail({
    from: { email: "alice@example.com" },
    to: [{ email: "bob@example.com" }],
    subject: "hello",
    text: "world",
  });
  yield* Effect.log(`queued as ${result.messageId}`);
});

const layer = makeSmtpClient(
  makeNodeTcpTransport(),
  { host: "smtp.example.com", port: 587 },
);

Effect.runPromise(program.pipe(Effect.provide(layer)));
```

## Quick start — server

```ts
import { Effect } from "effect";
import { listenSmtp } from "effect-smtp/server";

const program = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* listenSmtp({
      port: 2525,
      name: "my-app",
      onData: (stream) =>
        Effect.gen(function* () {
          const lines = yield* stream.lines;
          yield* Effect.log(`got ${lines.length} lines`);
        }),
    });
    yield* Effect.log(`listening on ${server.host}:${server.port}`);
    yield* Effect.never;
  }),
);

Effect.runPromise(program);
```

## Layout

- `src/shared/` — schemas, errors, reply parser, transport seam,
  in-memory transport, internal helpers (`base64`, `quoted-printable`,
  `data-parser`).
- `src/client/` — submission client (`SmtpClient` service).
- `src/server/` — receiving server (`listenSmtp`).
- `src/transport/node-tcp.ts` — the **only** file in the library that
  imports `node:net` / `node:tls`.

## Subpath exports

```json
{
  ".": "./src/index.ts",
  "./errors": "./src/shared/errors.ts",
  "./envelope": "./src/shared/envelope.ts",
  "./transport": "./src/shared/transport/index.ts"
}
```

The `./transport` subpath is the structural seam only — pure
TypeScript interfaces. The Node TCP / TLS implementations live under
`./transport/node-tcp` and are added in a follow-up.

## Errors

Every domain error is a `Schema.TaggedErrorClass` with an
`effect-smtp/*` literal `_tag`. `Effect.catchTag` discriminates them.

| `_tag`                       | When it fires                                      |
| ---------------------------- | -------------------------------------------------- |
| `effect-smtp/SmtpError`      | Transport / protocol failure during a client step  |
| `effect-smtp/SmtpGreetingError` | Server's greeting was non-220                  |
| `effect-smtp/SmtpAuthError`  | Authentication failed (bad credentials / 535)      |
| `effect-smtp/SmtpTlsError`   | STARTTLS wrap or handshake failed                   |
| `effect-smtp/SmtpConnectionClosed` | Underlying transport closed unexpectedly      |
| `effect-smtp/SmtpParseError` | Reply did not match RFC 5321 §4.2                   |
| `effect-smtp/SmtpRejectError` | Server-side rejection from an `onMailFrom`/`onRcptTo`/`onData` callback |

## Development

- `nub run lint` — oxlint
- `nub run fmt` — oxfmt
- `nub run check-types` — `tsc --noEmit`
- `nub run test` — vitest
- `nub scripts/smoke-client.ts` — live submission to a real server
  (set `SMTP_HOST`, `SMTP_PORT`, `FROM`, `TO`).

### Real-server test suites

- **swaks**: `brew install swaks`. Run `nub run test` — the swaks
  compatibility test in `test/integration/swaks.test.ts` brings up
  the server, runs `swaks` against it, and asserts on the captured
  DATA callback.
- **mailpit**: `docker run -d --rm -p 8025:8025 -p 1025:1025
  axllent/mailpit`. Set `MAILPIT_HOST=127.0.0.1 MAILPIT_PORT=1025` and
  point the smoke script at it.
- **smtp4dev**: `docker run -d --rm -p 5000:80 -p 2525:25
  rnwood/smtp4dev`. The smoke script's defaults already point to
  `smtp4.dev:2525` (the public sandbox).

## Status

Beta 0.1 — submission client + receiving server over a shared
`Transport` seam. STARTTLS upgrade is supported on the client side;
server-side STARTTLS is wired but the cert/key plumbing is left to
the caller. Auth is PLAIN, LOGIN, XOAUTH2 on the client and PLAIN,
LOGIN on the server.
