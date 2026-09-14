import { describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import { makeSmtpClient, SmtpClient } from "../../src/client/service.ts";
import { makeNodeTcpTransport } from "../../src/shared/transport/node-tcp.ts";
import { listenSmtp } from "../../src/server/server.ts";
import { connectSmtp, ehlo } from "../../src/client/effects.ts";
import { readReply } from "../../src/shared/response.ts";
import { findFreePort } from "./_helpers.ts";

const startServer = (
  port: number,
  collected: Array<{ from: string; subject: string; body: string }>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* listenSmtp({
        port,
        name: "test.server",
        maxSize: 0,
        onData: (stream) =>
          Effect.gen(function* () {
            const lines = yield* stream.lines;
            const fromLine =
              lines.find((l) => l.toLowerCase().startsWith("from:")) ?? "";
            const fromMatch = /<([^>]+)>/.exec(fromLine);
            const from = fromMatch?.[1] ?? fromLine.split(":")[1]?.trim() ?? "";
            const subject =
              lines
                .find((l) => l.toLowerCase().startsWith("subject:"))
                ?.split(":")[1]
                ?.trim() ?? "";
            const bodyStart = lines.findIndex((l) => l === "");
            const body =
              bodyStart >= 0 ? lines.slice(bodyStart + 1).join("\n") : "";
            collected.push({ from, subject, body });
          }),
      });
      yield* Effect.never;
    }),
  );

const startCollectServer = (port: number, collected: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* listenSmtp({
        port,
        name: "test.server",
        maxSize: 0,
        onData: (stream) =>
          Effect.gen(function* () {
            const lines = yield* stream.lines;
            collected.push(lines.join("\n"));
          }),
      });
      yield* Effect.never;
    }),
  );

describe("round-trip integration (client → real TCP server)", () => {
  it("sends a full message end-to-end", async () => {
    const port = await findFreePort();
    const collected: Array<{ from: string; subject: string; body: string }> =
      [];
    const serverFiber = Effect.runFork(startServer(port, collected));
    try {
      await Effect.runPromise(Effect.sleep("100 millis"));

      const transport = makeNodeTcpTransport();
      const layer = makeSmtpClient(transport, {
        host: "127.0.0.1",
        port,
      });

      const program = Effect.gen(function* () {
        const client = yield* SmtpClient;
        const result = yield* client.sendEmail({
          from: { email: "alice@example.com" },
          to: [{ email: "bob@example.com" }],
          subject: "round-trip",
          text: "hello via effect-smtp",
        });
        return result;
      });

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      );
      expect(result.messageId).toBeTruthy();

      await Effect.runPromise(Effect.sleep("100 millis"));
      expect(collected).toHaveLength(1);
      expect(collected[0]?.from).toBe("alice@example.com");
      expect(collected[0]?.subject).toBe("round-trip");
      expect(collected[0]?.body).toContain("hello via effect-smtp");
    } finally {
      Effect.runFork(Fiber.interrupt(serverFiber));
    }
  });
});

describe("raw client commands", () => {
  it("manual EHLO + MAIL + RCPT + DATA sequence", async () => {
    const port = await findFreePort();
    const collected: string[] = [];
    const serverFiber = Effect.runFork(startCollectServer(port, collected));
    try {
      await Effect.runPromise(Effect.sleep("100 millis"));
      const transport = makeNodeTcpTransport();
      const conn = await Effect.runPromise(
        connectSmtp(transport, "127.0.0.1", port),
      );
      const ehloResult = await Effect.runPromise(ehlo(conn, "manual.test"));
      expect(ehloResult.code).toBe(250);

      await Effect.runPromise(conn.writeLine("MAIL FROM:<a@b.com>"));
      const mailReply = await Effect.runPromise(readReply(conn.readLine));
      expect(mailReply.code).toBe(250);

      await Effect.runPromise(conn.writeLine("RCPT TO:<c@d.com>"));
      const rcptReply = await Effect.runPromise(readReply(conn.readLine));
      expect(rcptReply.code).toBe(250);

      await Effect.runPromise(conn.writeLine("DATA"));
      const dataReply = await Effect.runPromise(readReply(conn.readLine));
      expect(dataReply.code).toBe(354);

      await Effect.runPromise(conn.writeLine("Subject: manual"));
      await Effect.runPromise(conn.writeLine(""));
      await Effect.runPromise(conn.writeLine("manual body"));
      await Effect.runPromise(conn.writeLine("."));
      const ok = await Effect.runPromise(readReply(conn.readLine));
      expect(ok.code).toBe(250);

      await Effect.runPromise(conn.writeLine("QUIT"));

      await Effect.runPromise(Effect.sleep("100 millis"));
      expect(collected).toHaveLength(1);
      expect(collected[0]).toContain("Subject: manual");
      expect(collected[0]).toContain("manual body");
    } finally {
      Effect.runFork(Fiber.interrupt(serverFiber));
    }
  });
});
