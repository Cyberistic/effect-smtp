# effect-smtp — implementation plan

## Goal

A pure, Effect-native SMTP client **and server** library under one
package. The Transport seam is shared. Mail-shape (RFC 5322) is shared.
The protocol parser is shared. Only the connection-direction halves
differ.

## Top-level shape

```
src/
├── index.ts                # public re-exports (both surfaces)
├── envelope.ts             # schemas (EmailAddress, SendRequest, …)
├── errors.ts               # TaggedError hierarchy
├── response.ts             # multi-line reply parser
├── transport/
│   ├── index.ts            # structural Transport seam (shared)
│   ├── in-memory.ts        # in-memory Transport (tests)
│   └── node-tcp.ts         # node:net impl (only file allowed node:net)
├── internal/
│   ├── line-reader.ts      # Stream-based line reader (LF/CRLF, both)
│   ├── line-writer.ts      # Stream-based line writer (CRLF)
│   ├── data-parser.ts      # RFC 5321 §4.5.2 dot-unstuffing DATA mode
│   ├── base64.ts           # no-deps base64
│   ├── quoted-printable.ts # body encoding per RFC 2045 §6.7
│   └── server-context.ts   # per-connection ServerSession state
├── client/                 # submission client
│   ├── index.ts            # re-exports
│   ├── client.ts           # makeSmtpClient
│   ├── service.ts          # SmtpClient Tag + SmtpClientLive
│   └── effects.ts          # connect, ehlo, auth, mailFrom, rcptTo, data, quit
└── server/                 # receiving server
    ├── index.ts            # re-exports
    ├── server.ts           # SmtpServer.make
    ├── service.ts          # SmtpServer Tag + SmtpServerLive
    ├── session.ts          # SmtpSession + handlers
    └── auth.ts             # PLAIN / LOGIN / CRAM-MD5 / XOAUTH2

test/
├── client/                 # client tests
├── server/                 # server tests (using real in-memory network)
└── integration/            # mailpit + swaks + smtp4dev compatibility tests

scripts/
├── smoke-client.ts         # live smoke: send to smtp4.dev:2525
└── smoke-server.ts         # live smoke: receive with swaks
```

## Hard constraints (carry over from original task)

- No SMTP SDKs as deps. Hand-written SMTP only.
- `src/transport/node-tcp.ts` is the **only** file allowed to import
  `node:net` / `node:tls`. Everything else is pure.
- No `any`. No `as` casts (the ESMTP reply parser is hand-rolled, see
  `response.ts`).
- All errors are `Schema.TaggedErrorClass` with `effect-smtp/*` literal
  `_tag`.
- The Transport seam is the **only** place that touches the network.
  Every Effect outside the transport is pure.

## Subpath exports

```json
{
  ".": "./src/index.ts",
  "./client": "./src/client/index.ts",
  "./server": "./src/server/index.ts",
  "./errors": "./src/errors.ts",
  "./envelope": "./src/envelope.ts",
  "./transport": "./src/transport/index.ts"
}
```

## Public types (subset, rest in source)

### Shared

```ts
// src/transport/index.ts
export interface SmtpConnection {
  readonly readLine: Effect.Effect<string, SmtpConnectionClosed>;
  readonly writeLine: (line: string) => Effect.Effect<void, SmtpConnectionClosed>;
  readonly close: Effect.Effect<void, never>;
}

export interface Transport {
  readonly connect: (o: { host: string; port: number; timeoutMs?: number })
    => Effect.Effect<SmtpConnection, SmtpError>;
  readonly upgradeTls: (c: SmtpConnection) => Effect.Effect<SmtpConnection, SmtpTlsError>;
}
```

### Client

```ts
// src/client/client.ts
export const makeSmtpClient: (options: MakeSmtpClientOptions) => Effect.Effect<SmtpClient.Service, SmtpError>;

// src/client/service.ts
export class SmtpClient extends Context.Service<SmtpClient, {
  readonly sendEmail: (req: SendRequest) => Effect.Effect<{ messageId: string }, SmtpError | SmtpAuthError | SmtpConnectionClosed>;
  readonly close: Effect.Effect<void, never>;
  readonly runWithConnection: <A, E>(body: (c: SmtpConnection) => Effect.Effect<A, E | SmtpError>) => Effect.Effect<A, E | SmtpError>;
}>()("effect-smtp/SmtpClient") {}

export const SmtpClientLive: (transport: Transport, options: MakeSmtpClientOptions) => Layer.Layer<SmtpClient>;
```

### Server

```ts
// src/server/server.ts
export const SmtpServer: {
  readonly make: (options: SmtpServerOptions) => Layer.Layer<SmtpServer>;
};

// src/server/service.ts
export class SmtpServer extends Context.Service<SmtpServer, {
  readonly listen: (port: number, host?: string) => Effect.Effect<void, SmtpError, Scope.Scope>;
  readonly close: Effect.Effect<void, never>;
}>()("effect-smtp/SmtpServer") {}

export type SmtpServerOptions = {
  readonly name?: string;
  readonly banner?: string;
  readonly authMethods?: ReadonlyArray<"PLAIN" | "LOGIN" | "CRAM-MD5" | "XOAUTH2">;
  readonly maxSize?: number;
  readonly socketTimeout?: number;
  readonly onAuth?: (auth: AuthObject, session: SmtpSession) => Effect.Effect<{ user: unknown } | undefined, SmtpAuthError>;
  readonly onMailFrom?: (address: SmtpAddress, session: SmtpSession) => Effect.Effect<void, SmtpRejectError>;
  readonly onRcptTo?: (address: SmtpAddress, session: SmtpSession) => Effect.Effect<void, SmtpRejectError>;
  readonly onData: (stream: DataStream, session: SmtpSession) => Effect.Effect<void, SmtpRejectError>;
  readonly onClose?: (session: SmtpSession) => Effect.Effect<void, never>;
  readonly tls?: { key: string; cert: string };
};
```

## Protocol support — what to implement

### Client (submission)
- Connect, read greeting (must be 220)
- EHLO / HELO
- STARTTLS upgrade, then re-EHLO
- AUTH PLAIN, LOGIN, XOAUTH2 (CRAM-MD5 out of v0.1 scope — see "Out of
  scope")
- MAIL FROM, RCPT TO (per-recipient error)
- DATA (RFC 5321 §4.5.2 dot-stuffing, quoted-printable for body)
- QUIT
- 421 on greeting → SmtpGreetingError
- 5xx on MAIL/RCPT → SmtpError with `kind: "mail" | "rcpt"`

### Server (receive)
- Listen on TCP, fork a fiber per connection (one Effect per connection
  in its own Scope)
- Greet 220, parse EHLO/HELO/LHLO
- STARTTLS upgrade
- AUTH (PLAIN, LOGIN, CRAM-MD5, XOAUTH2)
- MAIL FROM, RCPT TO (with SIZE / BODY / SMTPUTF8 / DSN args)
- DATA (dot-unstuffing, size limit, callback delivers DataStream)
- QUIT (221), RSET, NOOP
- Honor `maxClients`, `socketTimeout`, `closeTimeout`
- LMTP mode toggle (LHLO instead of EHLO; per-recipient final response)

## Test suites (CI)

- **Unit (in-memory transport)**: parser, envelope, auth, data mode.
  No network, no docker.
- **Compatibility (in-memory server, real client or vice-versa)**: round-
  trip client → server and server → client.
- **Real-server (smtp4dev Docker / mailpit)**: bring up a real SMTP
  server, run the client against it. `smoke:server` script also runs
  swaks against the in-process server.

## Out of scope (v0.1)

- DKIM signing on outbound.
- MIME multipart assembly beyond text/html + quoted-printable.
- SMTP inbound queueing / retries / idempotency.
- Proxy headers (XCLIENT, XFORWARD).
- CRAM-MD5 on the **client** (server side supported; client-side deferred).
- DSN (`NOTIFY`, `ORCPT`, `ENVID` parsing on the server is fine; sending
  with DSN on the client is deferred).
