# Tools / Libraries — effect-smtp

## Runtime

- **Node** — pinned via `.node-version`, provisioned by nub.
- **nub** — runs TS, scripts, packages; replaces node/bun/npm/npx. See
  `.agents/skills/nub/`.

## Dependencies

- **effect@4.0.0-rc.112** — Effect runtime, Schema, Context. The library
  is Effect-native; everything returns `Effect.Effect<Success, DomainError>`.
  No SMTP SDKs; no `node:` imports outside `src/shared/transport/node-tcp.ts`
  and `src/server/server.ts`.

## Dev tooling

- **vitest@^2** — test runner (24 tests, no external processes).
- **typescript@^5.5** — strict, target ES2022, module ESNext.
- **oxlint@^1** + **oxfmt@^0.59** — linter + formatter.
- **lefthook** — pre-commit (oxfmt + oxlint), pre-push (test).
- **alchemy@^2.0.0-beta.77** — declares the Docker test fixtures
  (`alchemy.test.ts`) as `Docker.Container` / `Docker.Network` /
  `Docker.RemoteImage` resources; `scripts/test-docker.ts` deploys,
  tests, and destroys through the CLI.
- **@effect/platform-node@4.0.0-rc.112** (+ `@effect/platform-node-shared`,
  pinned via `pnpm.overrides`) — required by the alchemy CLI. Pinned to
  the same rc as `effect`: rc.115 renamed `Config.string` to
  `Config.String`, which alchemy 2.0.0-beta.77 does not follow yet.

## External test deps (not npm)

- **swaks** (`brew install swaks`) — `test/integration/swaks.test.ts`
  drives our server with a real third-party client.
- **mailpit** + **smtp4dev** (Docker images) — real servers our client
  submits to; brought up by `nub run test:docker`.

## Conventions

- The Transport seam (`src/shared/transport/index.ts`) is the only place
  that touches the network. `readLine` for command mode, `readChunk` for
  bulk DATA.
- Domain errors are `Schema.TaggedErrorClass` with an `effect-smtp/*`
  literal `_tag`, catchable via `Effect.catchTag`.
- `Effect.die` is reserved for invariant violations — never for I/O.
- Public surface is pure ESM, strict TS, target ES2022.
- Benchmark (`nub run bench`) against the bun-smtp reference; results in
  `bench/RESULTS.md`.
