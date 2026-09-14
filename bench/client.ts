/**
 * Minimal raw-TCP SMTP client used to drive every benchmark target
 * identically. Node's `node:net` so it runs under nub (our runtime),
 * matching the effect-smtp server's own transport.
 */
import { Socket } from "node:net";

export class SmtpBenchClient {
  private socket: Socket | null = null;
  private buffer = "";
  private resolveLine: ((line: string) => void) | null = null;
  private lines: string[] = [];
  private readonly encoder = new TextEncoder();

  connect(port: number, host = "127.0.0.1"): Promise<string> {
    return new Promise((outerResolve, outerReject) => {
      const socket = new Socket();
      this.socket = socket;
      socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let nl = this.buffer.indexOf("\n");
        while (nl !== -1) {
          const line = this.buffer.slice(0, nl).replace(/\r$/, "");
          this.buffer = this.buffer.slice(nl + 1);
          nl = this.buffer.indexOf("\n");
          if (this.resolveLine) {
            const res = this.resolveLine;
            this.resolveLine = null;
            res(line);
          } else {
            this.lines.push(line);
          }
        }
      });
      socket.once("error", outerReject);
      socket.once("connect", () => {
        socket.removeListener("error", outerReject);
        socket.on("error", (err) => {
          console.error("bench client error", err.message);
        });
        this.readLine().then(outerResolve);
      });
      socket.connect({ port, host });
    });
  }

  readLine(): Promise<string> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.resolveLine = resolve;
    });
  }

  async readResponse(): Promise<string> {
    let last = "";
    while (true) {
      const line = await this.readLine();
      last = line;
      if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) return last;
    }
  }

  private writeAll(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("not connected"));
    return new Promise((resolve, reject) => {
      socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  send(line: string): Promise<void> {
    return this.writeAll(this.encoder.encode(`${line}\r\n`));
  }

  sendRaw(data: string): Promise<void> {
    return this.writeAll(this.encoder.encode(data));
  }

  close(): void {
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      // already closed
    }
  }
}
