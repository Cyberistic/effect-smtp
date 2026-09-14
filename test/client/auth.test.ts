import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeInMemoryTransport } from "../../src/shared/transport/in-memory.ts";
import { SmtpClient, makeSmtpClient } from "../../src/client/service.ts";
import { connectSmtp, ehlo } from "../../src/client/effects.ts";
import {
  authLogin,
  authPlain,
  authXOauth2,
} from "../../src/client/auth-data.ts";
import { SmtpAuthError } from "../../src/shared/errors.ts";

const buildTransport = (replies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const t = yield* makeInMemoryTransport({ replies });
    return t;
  });

describe("auth PLAIN", () => {
  it("sends AUTH PLAIN with the initial response and accepts 235", async () => {
    const transport = await Effect.runPromise(
      buildTransport([
        "220 mx.example.com",
        "250 mx.example.com",
        "235 2.7.0 Authentication successful",
      ]),
    );
    const program = Effect.gen(function* () {
      const conn = yield* connectSmtp(transport, "mx.example.com", 587);
      yield* ehlo(conn, "client.example.com");
      yield* authPlain(conn, "user", "secret");
    });
    await Effect.runPromise(program);
    const written = await Effect.runPromise(transport.written);
    const plainLine = written.find((l) => l.startsWith("AUTH PLAIN"));
    expect(plainLine).toBeDefined();
    expect(plainLine).toContain("AUTH PLAIN");
  });

  it("fails with SmtpAuthError on 535", async () => {
    const transport = await Effect.runPromise(
      buildTransport([
        "220 mx.example.com",
        "250 mx.example.com",
        "535 5.7.8 Authentication failed",
      ]),
    );
    const program = Effect.gen(function* () {
      const conn = yield* connectSmtp(transport, "mx.example.com", 587);
      yield* ehlo(conn, "client.example.com");
      yield* authPlain(conn, "user", "wrong");
    });
    const error = await Effect.runPromise(program.pipe(Effect.flip));
    expect(error).toBeInstanceOf(SmtpAuthError);
    expect((error as SmtpAuthError).response).toContain("535");
  });
});

describe("auth LOGIN", () => {
  it("completes the two-step exchange", async () => {
    const transport = await Effect.runPromise(
      buildTransport([
        "220 mx.example.com",
        "250 mx.example.com",
        "334 VXNlcm5hbWU6",
        "334 UGFzc3dvcmQ6",
        "235 2.7.0 OK",
      ]),
    );
    const program = Effect.gen(function* () {
      const conn = yield* connectSmtp(transport, "mx.example.com", 587);
      yield* ehlo(conn, "client.example.com");
      yield* authLogin(conn, "user", "secret");
    });
    await Effect.runPromise(program);
    const written = await Effect.runPromise(transport.written);
    expect(
      written.filter((l) => l.startsWith("AUTH LOGIN") || l.length > 0),
    ).toEqual(["EHLO client.example.com", "AUTH LOGIN", "dXNlcg", "c2VjcmV0"]);
  });
});

describe("auth XOAUTH2", () => {
  it("sends the XOAUTH2 initial response", async () => {
    const transport = await Effect.runPromise(
      buildTransport([
        "220 mx.example.com",
        "250 mx.example.com",
        "235 2.7.0 OK",
      ]),
    );
    const program = Effect.gen(function* () {
      const conn = yield* connectSmtp(transport, "mx.example.com", 587);
      yield* ehlo(conn, "client.example.com");
      yield* authXOauth2(conn, "user@example.com", "ya29.token");
    });
    await Effect.runPromise(program);
    const written = await Effect.runPromise(transport.written);
    const xoauth2 = written.find((l) => l.startsWith("AUTH XOAUTH2"));
    expect(xoauth2).toBeDefined();
  });
});

describe("SmtpClient service", () => {
  it("provides sendEmail through Layer", async () => {
    const transport = await Effect.runPromise(
      buildTransport([
        "220 mx.example.com",
        "250 mx.example.com",
        "250 OK MAIL",
        "250 OK RCPT",
        "354 Send data",
        "250 OK message queued",
      ]),
    );
    const layer = makeSmtpClient(transport, {
      host: "mx.example.com",
      port: 587,
    });
    const program = Effect.gen(function* () {
      const client = yield* SmtpClient;
      const result = yield* client.sendEmail({
        from: { email: "alice@example.com" },
        to: [{ email: "bob@example.com" }],
        subject: "hello",
        text: "world",
      });
      return result;
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(result.messageId).toBeTruthy();
    const written = await Effect.runPromise(transport.written);
    expect(written).toContain("MAIL FROM:<alice@example.com>");
    expect(written).toContain("RCPT TO:<bob@example.com>");
    expect(written).toContain("DATA");
  });
});
