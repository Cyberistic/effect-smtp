import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { makeInMemoryTransport } from "../../src/shared/transport/in-memory.ts";
import { SmtpClient, makeSmtpClient } from "../../src/client/service.ts";

const buildTransport = (replies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const t = yield* makeInMemoryTransport({ replies });
    return t;
  });

describe("SmtpClient service", () => {
  it("provides sendEmail through Layer with custom transport", async () => {
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

  it("exposes runWithConnection for raw access", async () => {
    const transport = await Effect.runPromise(
      buildTransport(["220 mx.example.com", "250 mx.example.com"]),
    );
    const layer = makeSmtpClient(transport, {
      host: "mx.example.com",
      port: 587,
    });
    const program = Effect.gen(function* () {
      const client = yield* SmtpClient;
      const greeting = yield* client.runWithConnection((_conn) =>
        Effect.succeed("connected" as const),
      );
      return greeting;
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(result).toBe("connected");
  });

  it("layer is a valid Layer with the right error type", () => {
    const transport = Effect.runSync(
      Effect.gen(function* () {
        return yield* makeInMemoryTransport({ replies: ["220 go", "250 ok"] });
      }),
    );
    const layer = makeSmtpClient(transport, { host: "x", port: 1 });
    expect(Layer.isLayer(layer)).toBe(true);
  });
});
