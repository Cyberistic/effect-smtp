import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createConnection, createServer } from "node:net";

const execAsync = promisify(exec);

/** Pre-cleanup: remove any leftover containers from a previous test run. */
export const cleanupContainers = async (
  names: ReadonlyArray<string>,
): Promise<void> => {
  await execAsync(`docker rm -f ${names.join(" ")} 2>/dev/null; true`, {
    timeout: 30_000,
  }).catch(() => undefined);
};

/** Pull image if not already present. */
export const ensureImage = async (image: string): Promise<boolean> => {
  try {
    await execAsync(`docker inspect ${image}`, { timeout: 5_000 });
    return true;
  } catch {
    try {
      await execAsync(`docker pull ${image}`, { timeout: 300_000 });
      return true;
    } catch {
      return false;
    }
  }
};

/** Run a side-effect-free inspect on a container by name. */
export const inspectContainer = async (
  name: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const { stdout } = await execAsync(`docker inspect ${name}`, {
      timeout: 5_000,
    });
    return JSON.parse(stdout.trim())[0] ?? null;
  } catch {
    return null;
  }
};

export interface ContainerHandle {
  readonly name: string;
  readonly hostPort: number;
  readonly stop: () => Promise<void>;
}

/** Find a free host port. */
export const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
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

/**
 * Start `image`, publishing `containerPort` on a random host port.
 * Returns a stop thunk and the resolved host port. Returns null on
 * startup failure.
 */
export const startContainer = async (
  name: string,
  image: string,
  containerPort: number,
): Promise<ContainerHandle | null> => {
  const hostPort = await findFreePort();
  try {
    await execAsync(
      `docker rm -f ${name} 2>/dev/null; true; docker run -d --rm ` +
        `--name ${name} -p 127.0.0.1:${hostPort}:${containerPort} ${image}`,
      { timeout: 120_000 },
    );
  } catch {
    return null;
  }
  return {
    name,
    hostPort,
    stop: async () => {
      await execAsync(`docker stop ${name}`, { timeout: 30_000 }).catch(
        () => undefined,
      );
    },
  };
};

/**
 * Probe a port once for an RFC 5321 220 greeting. Attaches the data
 * and error listeners BEFORE the socket connects, so a refused
 * connection (container still booting) rejects instead of hanging on
 * an unhandled `error` event.
 */
const probeSmtp = (port: number, timeoutMs: number): Promise<string> =>
  new Promise<string>((resolve, reject) => {
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

/**
 * Wait until the SMTP port speaks an RFC 5321 220 greeting. Polls
 * every 500 ms up to `timeoutMs`. Returns true if the port opened
 * within the budget.
 */
export const waitForSmtp = async (
  port: number,
  timeoutMs = 90_000,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const greeting = await probeSmtp(port, 3_000);
      if (greeting.startsWith("220 ")) return true;
    } catch {
      // refused / timeout → retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

void execAsync;
