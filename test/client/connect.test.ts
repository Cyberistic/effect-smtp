import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeInMemoryTransport } from "../../src/shared/transport/in-memory.ts";
import { connectSmtp, ehlo } from "../../src/client/effects.ts";
import { SmtpGreetingError } from "../../src/shared/errors.ts";

describe("connectSmtp + ehlo", () => {
  it("connects, reads greeting, sends EHLO", async () => {
    const transport = await Effect.runPromise(
      makeInMemoryTransport({
        replies: [
          "220 mx.example.com ESMTP ready",
          "250-mx.example.com",
          "250-PIPELINING",
          "250-8BITMIME",
          "250 SMTPUTF8",
        ],
      }),
    );

    const program = Effect.gen(function* () {
      const conn = yield* connectSmtp(transport, "mx.example.com", 587);
      const ehloRes = yield* ehlo(conn, "client.example.com");
      return { conn, ehloRes };
    });

    const result = await Effect.runPromise(program);
    expect(result.ehloRes.code).toBe(250);
    expect(result.ehloRes.enhanced).toBe(true);
    expect(result.ehloRes.extensions.map((e) => e.keyword)).toEqual([
      "PIPELINING",
      "8BITMIME",
      "SMTPUTF8",
    ]);

    const written = await Effect.runPromise(transport.written);
    expect(written).toEqual(["EHLO client.example.com"]);
  });

  it("fails with SmtpGreetingError on non-220 greeting", async () => {
    const transport = await Effect.runPromise(
      makeInMemoryTransport({
        replies: ["421 mx.example.com Service not available"],
      }),
    );
    const program = connectSmtp(transport, "mx.example.com", 587);
    const error = await Effect.runPromise(program.pipe(Effect.flip));
    expect(error).toBeInstanceOf(SmtpGreetingError);
    expect((error as SmtpGreetingError).raw).toContain("421");
  });
});
