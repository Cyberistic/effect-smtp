import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeInMemoryTransport } from "../../src/shared/transport/in-memory.ts";
import { SmtpConnectionClosed } from "../../src/shared/errors.ts";

describe("in-memory Transport", () => {
  it("connect delivers the seed replies on readLine", async () => {
    const transport = await Effect.runPromise(
      makeInMemoryTransport({ replies: ["220 mx test", "250 OK"] }),
    );
    const conn = await Effect.runPromise(
      transport.connect({ host: "x", port: 1 }),
    );
    const first = await Effect.runPromise(conn.readLine);
    const second = await Effect.runPromise(conn.readLine);
    expect(first).toBe("220 mx test");
    expect(second).toBe("250 OK");
  });

  it("captures written lines for assertions", async () => {
    const transport = await Effect.runPromise(makeInMemoryTransport());
    const conn = await Effect.runPromise(
      transport.connect({ host: "x", port: 1 }),
    );
    await Effect.runPromise(conn.writeLine("EHLO a"));
    await Effect.runPromise(conn.writeLine("QUIT"));
    const written = await Effect.runPromise(transport.written);
    expect(written).toEqual(["EHLO a", "QUIT"]);
  });

  it("enqueueReplies injects server messages FIFO", async () => {
    const transport = await Effect.runPromise(makeInMemoryTransport());
    const conn = await Effect.runPromise(
      transport.connect({ host: "x", port: 1 }),
    );
    await Effect.runPromise(transport.enqueueReplies(["220 go", "250 OK"]));
    expect(await Effect.runPromise(conn.readLine)).toBe("220 go");
    expect(await Effect.runPromise(conn.readLine)).toBe("250 OK");
  });

  it("upgradeTls swaps the underlying connection", async () => {
    const transport = await Effect.runPromise(makeInMemoryTransport());
    const conn = await Effect.runPromise(
      transport.connect({ host: "x", port: 1 }),
    );
    const upgraded = await Effect.runPromise(transport.upgradeTls(conn));
    await Effect.runPromise(transport.enqueueReplies(["220 go"]));
    const afterTls = await Effect.runPromise(upgraded.readLine);
    expect(afterTls).toBe("220 go");
  });

  it("closed connection readLine fails with SmtpConnectionClosed", async () => {
    const transport = await Effect.runPromise(makeInMemoryTransport());
    const conn = await Effect.runPromise(
      transport.connect({ host: "x", port: 1 }),
    );
    await Effect.runPromise(conn.close);
    const error = await Effect.runPromise(conn.readLine.pipe(Effect.flip));
    expect(error).toBeInstanceOf(SmtpConnectionClosed);
  });
});
