import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import { makeSmtpClient, SmtpClient } from "../../src/client/service.ts";
import {
  cleanupContainers,
  ensureImage,
  startContainer,
  waitForSmtp,
  type ContainerHandle,
} from "./_docker.ts";

const MAILPIT = "axllent/mailpit:latest";
const SMTP4DEV = "rnwood/smtp4dev:latest";
const CONTAINERS = ["effect-smtp-mailpit", "effect-smtp-smtp4dev"];

const submit = (hostPort: number, subject: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { makeNodeTcpTransport } = yield* Effect.sync(
        () =>
          require("../../src/shared/transport/node-tcp.ts") as typeof import("../../src/shared/transport/node-tcp.ts"),
      );
      const transport = makeNodeTcpTransport();
      const layer = makeSmtpClient(transport, {
        host: "127.0.0.1",
        port: hostPort,
        timeoutMs: 10_000,
      });
      const program = Effect.gen(function* () {
        const client = yield* SmtpClient;
        return yield* client.sendEmail({
          from: { email: "alice@effect-smtp.test" },
          to: [{ email: "bob@effect-smtp.test" }],
          subject,
          text: "delivered via effect-smtp",
        });
      });
      return yield* program.pipe(Effect.provide(layer));
    }),
  );

describe("Docker fixtures: mailpit + smtp4dev", () => {
  beforeAll(async () => {
    await cleanupContainers(CONTAINERS);
    await ensureImage(MAILPIT);
    await ensureImage(SMTP4DEV);
  }, 600_000);

  describe("effect-smtp client → mailpit", () => {
    let handle: ContainerHandle | null = null;

    beforeAll(async () => {
      handle = await startContainer("effect-smtp-mailpit", MAILPIT, 1025);
      if (!handle) return;
      const ready = await waitForSmtp(handle.hostPort, 120_000);
      if (!ready) {
        await handle.stop();
        handle = null;
      }
    }, 240_000);

    afterAll(async () => {
      if (handle) await handle.stop();
    });

    it("delivers a message that mailpit accepts with 250", async () => {
      if (!handle) {
        console.warn("[skip] mailpit not reachable");
        return;
      }
      const result = await Effect.runPromise(
        submit(handle.hostPort, "mailpit compat"),
      );
      expect(result.messageId).toBeTruthy();
    });
  });

  describe("effect-smtp client → smtp4dev", () => {
    let handle: ContainerHandle | null = null;

    beforeAll(async () => {
      handle = await startContainer("effect-smtp-smtp4dev", SMTP4DEV, 25);
      if (!handle) return;
      const ready = await waitForSmtp(handle.hostPort, 120_000);
      if (!ready) {
        await handle.stop();
        handle = null;
      }
    }, 240_000);

    afterAll(async () => {
      if (handle) await handle.stop();
    });

    it("delivers a message that smtp4dev accepts with 250", async () => {
      if (!handle) {
        console.warn("[skip] smtp4dev not reachable");
        return;
      }
      const result = await Effect.runPromise(
        submit(handle.hostPort, "smtp4dev compat"),
      );
      expect(result.messageId).toBeTruthy();
    });
  });
});

void Fiber;
