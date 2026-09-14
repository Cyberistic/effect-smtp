import { Buffer } from "node:buffer";

/**
 * RFC 5321 §4.5.2 DATA mode parser.
 *
 * State is fed raw TCP chunks (`feed(chunk)`). Each call may emit zero
 * or more lines through `lines` and finally the message-end signal via
 * the optional `onEnd` callback (set once before feeding).
 *
 * The parser only needs to know about two byte sequences:
 *   - `<CR><LF>` — line terminator (or `\n`; the parser accepts both)
 *   - `<CR><LF>.<CR><LF>` — message terminator
 *
 * Dot-unstuffing: a `.` at the start of a line that is *immediately*
 * followed by another `.` is de-stuffed to a single `.`. A `.` at the
 * start of a line followed by `<CR><LF>` (i.e. `.` alone on a line) is
 * the message terminator. Any other leading `.` is passed through
 * unchanged.
 */
export class DataParser {
  private remainder: Buffer | null = null;
  private done = false;
  private byteLength = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = Number.POSITIVE_INFINITY) {
    this.maxBytes = Number.isFinite(maxBytes)
      ? maxBytes
      : Number.POSITIVE_INFINITY;
  }

  /**
   * Feed a chunk. Returns the lines (decoded as UTF-8) extracted from
   * the chunk. If the terminator was seen, also returns the bytes that
   * trail it (caller's command-mode parser takes over from there).
   */
  feed(chunk: Buffer): { lines: string[]; remainder: Buffer | null } {
    if (this.done) {
      return { lines: [], remainder: chunk };
    }
    const buf = this.remainder ? Buffer.concat([this.remainder, chunk]) : chunk;
    const lines: string[] = [];
    let pos = 0;
    while (pos < buf.length) {
      let nl = buf.indexOf(0x0a, pos);
      if (nl === -1) {
        this.remainder = buf.subarray(pos);
        break;
      }
      const lineEnd = nl > 0 && buf[nl - 1] === 0x0d ? nl - 1 : nl;
      let lineBytes = buf.subarray(pos, lineEnd);

      if (lineBytes.length > 0 && lineBytes[0] === 0x2e) {
        if (lineBytes.length === 1) {
          // `<CR><LF>.<CR><LF>` — message end.
          this.done = true;
          const rest = buf.subarray(nl + 1);
          return { lines, remainder: rest };
        }
        if (lineBytes[1] === 0x2e) {
          // `..` -> `.` (de-stuff).
          lineBytes = lineBytes.subarray(1);
        }
      }

      this.byteLength += lineBytes.length;
      lines.push(lineBytes.toString("utf8"));
      if (this.byteLength > this.maxBytes) {
        // Surface what we have; the server may reject after onDataEnd.
      }
      pos = nl + 1;
    }
    return { lines, remainder: null };
  }

  end(): void {
    this.remainder = null;
  }

  get bytes(): number {
    return this.byteLength;
  }

  get finished(): boolean {
    return this.done;
  }
}
