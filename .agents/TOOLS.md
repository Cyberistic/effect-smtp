# Tools / Libraries — effect-smtp

## Runtime

- **Node** — pinned via `.node-version`, provisioned by nub.
- **nub** — runs TS, scripts, packages; replaces node/bun/npm/npx. See `.agents/skills/nub/`.

## Dependencies

- **effect@4.0.0-rc.112** — Effect runtime, Schema, Context. The library is Effect-native; everything returns `Effect.Effect<Success, DomainError>`.
- No SMTP SDKs, no nodemailer, no `node:` imports outside `src/transport/node-tcp.ts`.

## Dev tooling

- **vitest@^2** — test runner.
- **typescript@^5.5** — strict, target ES2022, module ESNext.
- **oxlint@^1** + **oxfmt@^0.59** — linter + formatter.
- **lefthook** — pre-commit (oxfmt + oxlint), pre-push (test).

## Conventions

- The Transport seam (`src/transport/index.ts`) is the only place that touches the network.
- Domain errors are `Schema.TaggedErrorClass` with an `effect-smtp/*` literal `_tag` and are catchable by tag (`Effect.catchTag`).
- `Effect.die` is reserved for invariant violations — never for I/O failures.
- Public surface is pure ESM, strict TS, target ES2022.
