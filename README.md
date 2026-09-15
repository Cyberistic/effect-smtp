# effect-smtp

a very good Effect-native SMTP client and server. No external deps. Passes all tests and achieves ~throughput parity with other benchmarks.

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

- `src/shared/` — schemas, errors, reply parser, the `Transport` seam,
  the in-memory transport, and internal helpers (`address`,
  `base64`, `quoted-printable`, `data-parser`).
- `src/client/` — submission client (`SmtpClient` service).
- `src/server/` — receiving server (`listenSmtp`).
- `src/shared/transport/node-tcp.ts` (client) and `src/server/server.ts`
  (server) — the **only** two files that import `node:net` / `node:tls`.

## Subpath exports

```json
{
  ".": "./src/index.ts",
  "./client": "./src/client/index.ts",
  "./server": "./src/server/index.ts",
  "./errors": "./src/shared/errors.ts",
  "./envelope": "./src/shared/envelope.ts",
  "./transport": "./src/shared/transport/index.ts",
  "./transport/node-tcp": "./src/shared/transport/node-tcp.ts"
}
```

`./transport` is the structural seam (pure TypeScript interfaces) — the
`./transport/node-tcp` entry is the Node implementation.

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

- `nub run lint` / `nub run fmt` / `nub run check-types`
- `nub run test` — vitest (106 tests; no external processes)
- `nub run test:docker` — Docker integration via alchemy (see below)
- `nub run test:all` — both
- `nub run smoke` — live submission to a real server (set
  `SMTP_HOST`, `SMTP_PORT`, `FROM`, `TO`)
- `nub run smoke:server` — bring up the in-process server and drive
  it with `swaks`
- `nub run bench` — the benchmark below, writes `bench/RESULTS.md`

### Test surfaces

- **in-memory**: the fast suite. `test/client/*` drives the client
  against `makeInMemoryTransport` (scripted replies, no network) and
  `test/server/*` drives the server over a real loopback socket. No
  external processes.
- **swaks** (`brew install swaks`): `test/integration/swaks.test.ts`
  brings up the server, runs `swaks` against it, and asserts on the
  captured DATA callback.
- **mailpit** + **smtp4dev** (Docker): `nub run test:docker` deploys
  `alchemy.test.ts` — both mail servers declared as alchemy
  `Docker.Container` resources on one network — reads their bound host
  ports from the stack outputs, drives the real client against each,
  then destroys the stack. Alchemy gives the fixtures a lifecycle:
  a reviewable plan/diff, adopted images, and a teardown that removes
  exactly what it created.



## Benchmarks

`nub run bench` drives every server through the **same** raw-TCP client
(`bench/client.ts`) and the **same** scenarios, in separate OS
processes, and writes `bench/RESULTS.md`.

- `effect-smtp` runs on **both** runtimes (it uses `node:net`, which Bun
  implements), so a gap can be attributed: effect-smtp-on-Node vs
  effect-smtp-on-Bun isolates the runtime; effect-smtp-on-Bun vs
  bun-smtp-on-Bun isolates the implementation.
- [`bun-smtp`](https://github.com/puiusabin/bun-smtp) — the reference
  implementation. Runs on Bun (it uses `Bun.listen`).
- [`smtp-server`](https://github.com/nodemailer/smtp-server) — the
  widely-used Node implementation, the honest Node-to-Node baseline.

| Scenario | effect-smtp (Node) | effect-smtp (Bun) | bun-smtp (Bun) | smtp-server (Node) |
| --- | --- | --- | --- | --- |
| Concurrent transactions (50 connections) | 14,565 msg/s | 14,308 msg/s | 14,578 msg/s | 14,438 msg/s |
| Large payloads (10 connections, 1MB bodies) | **1,425 MB/s** | **1,537 MB/s** | 1,151 MB/s | 549 MB/s |
| Connection throughput¹ | 17,548 conn/s | 9,433 conn/s | 473 conn/s | 477 conn/s |

Apple M2 Pro (12 cores), Node 26.8.1, Bun 1.3.13. Best of 5 timed runs
after 2 warmups (best-of, not median).

¹ Both bun-smtp and smtp-server hardcode a 100ms early-talker delay
before the 220 greeting (see `smtp-server`'s `readyTimer`). That fixed
per-connection floor caps them near 500 conn/s at concurrency 50, so
this row measures that policy, not accept-loop throughput. effect-smtp
greets immediately. The two throughput rows are the real comparison.

**Reading the numbers.** Transactions are at parity with both
references. On large payloads we beat bun-smtp by ~24% and `smtp-server`
by ~2.6x — on the same runtime `smtp-server` uses. Two things got us
there, both in `src/shared/internal/data-parser.ts`:

- the DATA path reads **chunks**, not lines, so a megabyte is a handful
  of Effect suspensions instead of ~13k; and
- it scans for line starts with native `indexOf` jumps rather than a
  JS byte loop — that single change took Node from 349 MB/s to 1,449.

`DataStream.bytes` stays on the raw path; `DataStream.lines` splits and
decodes on demand, so a handler that only drains never pays for either.

## License

MIT
