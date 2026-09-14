You are one of Cyberistic's agents. He hates unclean code and hacks. He loves his documentations. LOCs IS a measure of quality, the LESS, the better.

General:

- You must use concise, clean code. No hacks should be used. If you need to write a paragraph-long comment to justify your code, you are doing it wrong. Find a better way.
- Security is above all. Always make it secure (typesafe, fail-safe, auth), then make it work and effectful (effectjs), then make it fast, then make it pretty.
- Shareable logic should be extracted into packages and reused across apps. Avoid copy-pasting code between apps. Hoist up if it's needed elsewhere.
- Prefer reading documentation over exploring package source code. Packages provide README files that link to their relevant documentation.
- Use Jiujitsu version control for all your code. Make sure to commit often and write meaningful commit messages. If you launch multiple agents, use jiujitsu workspaces to manage them. If you are unsure about how to use Jiujitsu, ask for help. https://aran.dev/posts/introducing-jjw-jj-workspace-manager/
- If you need to create Markdown files to track agent state, always place them under .agents/slop/
- If I ask you to use a repo as reference, and it isn't tiny, you must clone it into `references/` and use it as a reference. Add the repo to `.gitignore` and link it under `references/` in your README.
- Whenever you finish a task, make sure to tick it off in agents/TODO.md, If the task is not in TODO.md, add it there and check it off. Keep a progress bar inside TODO.md for each category of tasks. If it's an implementation detail or a small task, do not add it to TODO.md. Only add tasks that are meaningful and require tracking.
- Add TODO comments in the code for any tasks that are not yet completed, so we can use `rg` to search for TODO comments later on.
- Update .agents/TOOLS.md with the tools or libraries you're using, it will act as a ledger and overview for the project.

Development:

- Use nub (see `.agents/skills/nub/`) for everything: `nub <file>` to run TS, `nub run <script>`, `nubx <tool>`, `nub install` / `nub add`. Do NOT use bun — its `node:http` support is broken (it masked real server errors behind opaque `HTTPError`s). Plain Node (the `.node-version` pin) is the fallback.
- This is a single-package library (not a monorepo). The package is `effect-smtp`.
- Always prefer non-external services, or services that can be self-hosted. Sam (@samgoodwin, alchemy guy) has to be impressed by how effectful and self-contained your code is.
- Always use Effect and constantly refer to the official documentation: https://effectjs.org/docs/
- Error taxonomy: domain errors are `Schema.TaggedErrorClass` (wire-safe, catchable by tag); HTTP failures are the structural `httpError` (`{ status, body }`) decoded at the boundary; programmer/config errors are plain `Error` with a `effect-smtp:` prefix and the offending value in the message; `Effect.die` is for invariants only — never for I/O, disk, or network failures (those are `SmtpError`/`SmtpConnectionClosed`-style typed failures).
- Prefer existing libraries over installing new ones. If you need to install a new library, make sure it is actively maintained and has a good number of downloads. We want modern, well-maintained libraries. Ask and justify your choice before installing a new library.
- The Transport seam is the only place that touches the network. Every other Effect is pure. `src/transport/node-tcp.ts` is the only file allowed to import `node:net`.
- If you are writing a test, make sure it is testing something meaningful and not just testing for the sake of testing.
- Never silently ignore errors. Never ignore types. Never introduce `any` types or "temporary" hacks.
- Surface actionable error messages.
- Model expected failures with Effect instead of throwing exceptions.

Before push:
- `nub run lint`
- `nub run fmt`
- `nub run check-types`
- `nub run test`

lefthook (`lefthook.yml`) runs oxfmt + oxlint on pre-commit, test on pre-push. `LEFTHOOK=0` skips.
