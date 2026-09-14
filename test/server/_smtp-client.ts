import { Socket } from "node:net";
import * as tls from "node:tls";

/**
 * Minimal raw-TCP SMTP client for server tests: send lines, read
 * multi-line replies, and upgrade to TLS for STARTTLS. Deliberately
 * protocol-level (not our own client) so the server is exercised by an
 * independent implementation.
 */
export class TestSmtpClient {
  private socket: Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private resolveLine: ((line: string) => void) | null = null;
  private lines: string[] = [];

  private onData = (chunk: Buffer): void => {
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
  };

  connect(port: number, host = "127.0.0.1"): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.on("data", this.onData);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        socket.on("error", () => undefined);
        this.socket = socket;
        this.readLine().then(resolve);
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

  /** Read through a multi-line reply; returns the terminal line. */
  async readResponse(): Promise<string> {
    let last = "";
    while (true) {
      const line = await this.readLine();
      last = line;
      if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) return last;
    }
  }

  /** Read every line of a multi-line reply. */
  async readAll(): Promise<string[]> {
    const out: string[] = [];
    while (true) {
      const line = await this.readLine();
      out.push(line);
      if (/^\d{3} /.test(line)) return out;
    }
  }

  /** Upgrade the live socket to TLS (the client half of STARTTLS). */
  upgradeTLS(): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      if (!plain) {
        reject(new Error("not connected"));
        return;
      }
      plain.removeListener("data", this.onData);
      const secure = tls.connect({ socket: plain, rejectUnauthorized: false });
      secure.once("error", reject);
      secure.once("secureConnect", () => {
        secure.removeListener("error", reject);
        secure.on("error", () => undefined);
        secure.on("data", this.onData);
        this.socket = secure;
        resolve();
      });
    });
  }

  send(line: string): void {
    this.write(`${line}\r\n`);
  }

  sendRaw(data: string): void {
    this.write(data);
  }

  private write(data: string): void {
    if (!this.socket) throw new Error("not connected");
    this.socket.write(data);
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
