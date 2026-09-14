import type { Effect } from "effect";
import type {
  SmtpConnectionClosed,
  SmtpError,
  SmtpTlsError,
} from "../errors.ts";

export interface SmtpConnection {
  readonly readLine: Effect.Effect<string, SmtpConnectionClosed>;
  /**
   * Read the next raw byte chunk. Command mode uses {@link readLine};
   * DATA mode uses this so a 1 MB body is a handful of chunk reads
   * instead of ~13k line reads (one Effect per 76-byte line). The two
   * share the same underlying buffer: bytes read here are the bytes
   * `readLine` would otherwise have split, so switching between them
   * during a session (command → DATA → command) is safe.
   */
  readonly readChunk: Effect.Effect<Uint8Array, SmtpConnectionClosed>;
  readonly writeLine: (
    line: string,
  ) => Effect.Effect<void, SmtpConnectionClosed>;
  readonly close: Effect.Effect<void, never>;
}

export interface EhloExtension {
  readonly keyword: string;
  readonly params: string;
}

export interface EhloResponse {
  readonly code: number;
  readonly enhanced: boolean;
  readonly extensions: ReadonlyArray<EhloExtension>;
}

/**
 * Structural transport seam. Anyone can implement this — a TCP client,
 * a TLS-wrapped socket, a mock, anything that gives Effect-typed line
 * reads / writes / starttls / close.
 *
 * The library ships an in-memory and a node-tcp implementation; neither
 * is required at the call site.
 */
export interface Transport {
  readonly connect: (options: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs?: number;
  }) => Effect.Effect<SmtpConnection, SmtpError>;

  readonly upgradeTls: (
    connection: SmtpConnection,
  ) => Effect.Effect<SmtpConnection, SmtpTlsError>;
}

export const EHLO_KNOWN_KEYWORDS = [
  "STARTTLS",
  "AUTH",
  "SIZE",
  "8BITMIME",
  "SMTPUTF8",
  "ENHANCEDSTATUSCODES",
  "PIPELINING",
  "DSN",
  "HELP",
  "CHUNKING",
  "BINARYMIME",
] as const;

export const isEhloKeyword = (
  token: string,
): token is (typeof EHLO_KNOWN_KEYWORDS)[number] =>
  (EHLO_KNOWN_KEYWORDS as ReadonlyArray<string>).includes(token);

/**
 * Parse an EHLO multi-line response. The first line is the EHLO banner
 * (e.g. "mx.example.com"); subsequent continuation lines (`250-…`) and
 * the terminal line (`250 `) carry extensions. Each extension line
 * starts with `<KEYWORD>` (optionally followed by a space + params).
 */
export const parseEhlo = (lines: ReadonlyArray<string>): EhloResponse => {
  const extensions: EhloExtension[] = [];
  let code = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = Number.parseInt(line.slice(0, 3), 10);
    if (Number.isNaN(c)) continue;
    if (code === 0) code = c;
    if (c !== code) continue;
    if (i === 0) continue;
    const text = line.slice(4);
    const space = text.indexOf(" ");
    const keyword = space === -1 ? text : text.slice(0, space);
    const params = space === -1 ? "" : text.slice(space + 1);
    extensions.push({ keyword, params });
  }
  return { code, enhanced: code === 250, extensions };
};
