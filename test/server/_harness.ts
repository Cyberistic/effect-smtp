import { Effect, Fiber } from "effect";
import { listenSmtp, type SmtpServerOptions } from "../../src/server/server.ts";
import { findFreePort } from "../integration/_helpers.ts";
import { TestSmtpClient } from "./_smtp-client.ts";

export interface TestServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/**
 * Start a real server on a free loopback port and wait until it greets.
 * Returns a handle whose `stop` interrupts the serving fiber.
 */
export const makeServer = async (
  options: Omit<SmtpServerOptions, "port">,
): Promise<TestServer> => {
  const port = await findFreePort();
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* listenSmtp({ ...options, port, host: "127.0.0.1" });
        yield* Effect.never;
      }),
    ),
  );
  // Poll until it accepts connections.
  for (let i = 0; i < 100; i++) {
    try {
      const probe = new TestSmtpClient();
      await probe.connect(port);
      probe.close();
      return {
        port,
        stop: async () => {
          await Effect.runPromise(Fiber.interrupt(fiber));
        },
      };
    } catch {
      await Effect.runPromise(Effect.sleep("20 millis"));
    }
  }
  await Effect.runPromise(Fiber.interrupt(fiber));
  throw new Error("server did not start");
};

export { TestSmtpClient };
export { findFreePort };
