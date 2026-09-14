/**
 * Docker-backed integration tests for effect-smtp, driven through
 * alchemy's Docker provider.
 *
 * Deploys `alchemy.test.ts` (mailpit + smtp4dev as alchemy Containers),
 * reads the bound host ports out of the stack outputs, runs the client
 * against each, then destroys the stack — one lifecycle, no leftover
 * containers.
 *
 * Usage: `nub run test:docker`. Needs a reachable Docker daemon.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { Effect } from "effect";
import { makeSmtpClient, SmtpClient } from "../src/client/service.ts";
import { makeNodeTcpTransport } from "../src/shared/transport/node-tcp.ts";

const STACK = "alchemy.test.ts";
const STAGE = "test";

interface FixturePorts {
  readonly mailpitSmtp: number;
  readonly smtp4devSmtp: number;
}

const run = (
  args: ReadonlyArray<string>,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn("nubx", ["alchemy", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const parseOutputs = (stdout: string): FixturePorts | null => {
  const number = (key: string): number | null => {
    const m = new RegExp(`${key}:\\s*(\\d+)`).exec(stdout);
    return m?.[1] ? Number.parseInt(m[1], 10) : null;
  };
  const mailpitSmtp = number("mailpitSmtp");
  const smtp4devSmtp = number("smtp4devSmtp");
  if (mailpitSmtp === null || smtp4devSmtp === null) return null;
  return { mailpitSmtp, smtp4devSmtp };
};

/**
 * Poll a port for an RFC 5321 220 greeting. alchemy's `start: true`
 * returns when the container is running, not when the app inside is
 * listening — smtp4dev takes a few seconds to run its migrations — so
 * the test waits for the protocol to come up.
 */
const probeSmtp = (port: number, timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let buf = "";
    const sock = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("probe timeout"));
    }, timeoutMs);
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        sock.removeAllListeners();
        sock.end();
        resolve(buf.slice(0, nl).replace(/\r$/, ""));
      }
    });
    sock.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });

const waitForSmtp = async (port: number, timeoutMs = 90_000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const greeting = await probeSmtp(port, 3_000);
      if (greeting.startsWith("220 ")) return;
    } catch {
      // refused / timeout → retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`port ${port} never spoke SMTP within ${timeoutMs}ms`);
};

const submit = (
  port: number,
  subject: string,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const layer = makeSmtpClient(makeNodeTcpTransport(), {
      host: "127.0.0.1",
      port,
      timeoutMs: 10_000,
    });
    return yield* Effect.gen(function* () {
      const client = yield* SmtpClient;
      const result = yield* client.sendEmail({
        from: { email: "alice@effect-smtp.test" },
        to: [{ email: "bob@effect-smtp.test" }],
        subject,
        text: "delivered via effect-smtp",
      });
      return result.messageId;
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

let failures = 0;

const check = async (
  label: string,
  port: number,
  subject: string,
): Promise<void> => {
  try {
    await waitForSmtp(port);
    const messageId = await Effect.runPromise(submit(port, subject));
    console.log(`  ✓ ${label}: ${messageId}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${label}: ${String(err)}`);
  }
};

const main = async (): Promise<void> => {
  console.log("→ alchemy deploy (mailpit + smtp4dev)");
  const deployed = await run(["deploy", "--stage", STAGE, "--yes", STACK]);
  if (deployed.code !== 0) {
    console.error(deployed.stderr || deployed.stdout);
    console.error(
      "\nDeploy failed — is a Docker daemon reachable (`docker ps`)?",
    );
    process.exit(1);
  }
  const ports = parseOutputs(deployed.stdout);
  if (!ports) {
    console.error("could not read fixture ports from deploy output:");
    console.error(deployed.stdout);
    process.exit(1);
  }
  console.log(
    `  mailpit smtp=${ports.mailpitSmtp}  smtp4dev smtp=${ports.smtp4devSmtp}`,
  );

  try {
    await check("client → mailpit", ports.mailpitSmtp, "mailpit compat");
    await check("client → smtp4dev", ports.smtp4devSmtp, "smtp4dev compat");
  } finally {
    console.log("→ alchemy destroy");
    const destroyed = await run(["destroy", "--stage", STAGE, "--yes", STACK]);
    if (destroyed.code !== 0) {
      console.warn(`  destroy reported ${destroyed.code}; check for leftovers`);
    }
  }

  console.log(
    failures === 0 ? "\nall docker checks passed" : `\n${failures} failed`,
  );
  if (failures > 0) process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
