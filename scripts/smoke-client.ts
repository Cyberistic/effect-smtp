import { Effect } from "effect";
import { makeNodeTcpTransport } from "../src/shared/transport/node-tcp.ts";
import { makeSmtpClient, SmtpClient } from "../src/client/service.ts";

const main = Effect.gen(function* () {
  const host = process.env["SMTP_HOST"] ?? "smtp4.dev";
  const port = Number.parseInt(process.env["SMTP_PORT"] ?? "2525", 10);
  const transport = makeNodeTcpTransport();
  const layer = makeSmtpClient(transport, { host, port, timeoutMs: 10_000 });

  const program = Effect.gen(function* () {
    const client = yield* SmtpClient;
    const result = yield* client.sendEmail({
      from: { email: process.env["FROM"] ?? "smoke@effect-smtp.test" },
      to: [{ email: process.env["TO"] ?? "inbox@smtp4.dev" }],
      subject: `effect-smtp smoke ${new Date().toISOString()}`,
      text: "hello from effect-smtp",
    });
    yield* Effect.log(`sent: ${result.messageId}`);
  });

  yield* program.pipe(Effect.provide(layer), Effect.scoped);
});

Effect.runPromise(main).catch((err) => {
  console.error(err);
  process.exit(1);
});
