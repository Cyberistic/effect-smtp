import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { listenSmtp } from "../../src/server/server.ts";
import { readReply } from "../../src/shared/response.ts";
import type { SmtpConnection } from "../../src/shared/transport/index.ts";

const findFreePort = async (): Promise<number> => {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no address")));
      }
    });
  });
};

describe("SMTP server", () => {
  it("greets and answers EHLO with capabilities", async () => {
    const port = await findFreePort();
    const collected: Array<{ from: string; subject: string; body: string }> =
      [];
    const program = Effect.scoped(
      Effect.gen(function* () {
        const server = yield* listenSmtp({
          port,
          name: "effect-smtp.test",
          maxSize: 0,
          onData: (stream) =>
            Effect.gen(function* () {
              const lines = yield* stream.lines;
              const subject =
                lines
                  .find((l) => l.toLowerCase().startsWith("subject:"))
                  ?.split(":")[1]
                  ?.trim() ?? "";
              const from =
                lines
                  .find((l) => l.toLowerCase().startsWith("from:"))
                  ?.split(":")[1]
                  ?.trim() ?? "";
              const bodyStart = lines.findIndex((l) => l === "");
              const body =
                bodyStart >= 0 ? lines.slice(bodyStart + 1).join("\n") : "";
              collected.push({ from, subject, body });
            }),
        });

        const clientConn = yield* connectToServer(server.host, server.port);
        const greeting = yield* readReply(clientConn.readLine);
        expect(greeting.code).toBe(220);

        yield* clientConn.writeLine("EHLO test.client");
        const ehloLines: string[] = [];
        while (true) {
          const line = yield* clientConn.readLine;
          ehloLines.push(line);
          if (line.charAt(3) === " ") break;
        }
        const ehloText = ehloLines.map((l) => l.slice(4)).join(" | ");
        expect(ehloText).toContain("effect-smtp.test");
        expect(ehloText).toContain("8BITMIME");

        yield* clientConn.writeLine("MAIL FROM:<alice@example.com>");
        const mailReply = yield* readReply(clientConn.readLine);
        expect(mailReply.code).toBe(250);

        yield* clientConn.writeLine("RCPT TO:<bob@example.com>");
        const rcptReply = yield* readReply(clientConn.readLine);
        expect(rcptReply.code).toBe(250);

        yield* clientConn.writeLine("DATA");
        const dataReply = yield* readReply(clientConn.readLine);
        expect(dataReply.code).toBe(354);

        yield* clientConn.writeLine("From: alice@example.com");
        yield* clientConn.writeLine("To: bob@example.com");
        yield* clientConn.writeLine("Subject: hello");
        yield* clientConn.writeLine("");
        yield* clientConn.writeLine("world body");
        yield* clientConn.writeLine(".");
        const ok = yield* readReply(clientConn.readLine);
        expect(ok.code).toBe(250);

        yield* clientConn.writeLine("QUIT");
        const bye = yield* readReply(clientConn.readLine);
        expect(bye.code).toBe(221);

        yield* clientConn.close;
      }),
    );

    await Effect.runPromise(program);

    expect(collected).toEqual([
      {
        from: "alice@example.com",
        subject: "hello",
        body: "world body",
      },
    ]);
  });
});

const connectToServer = (
  host: string,
  port: number,
): Effect.Effect<SmtpConnection, never> =>
  Effect.gen(function* () {
    const { makeNodeTcpTransport } = yield* Effect.sync(
      () =>
        require("../../src/shared/transport/node-tcp.ts") as typeof import("../../src/shared/transport/node-tcp.ts"),
    );
    const transport = makeNodeTcpTransport();
    const conn = yield* Effect.orDie(
      transport.connect({ host, port, timeoutMs: 5000 }),
    );
    return conn;
  });
