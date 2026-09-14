/**
 * RFC 5321 §4.5.2 DATA mode parser.
 *
 * State is fed raw TCP chunks. It scans bytes only — it does **not**
 * decode lines. Each `feed` returns the body's line slices as
 * `Uint8Array`s (dot-unstuffed, CRLF stripped), plus the bytes that
 * trail the terminator for the caller's command-mode parser.
 *
 * Decoding to strings is the caller's choice: `DataStream.lines`
 * decodes on demand, so a handler that only drains the body never pays
 * for ~13k string allocations per megabyte.
 *
 * The parser only needs to know about two byte sequences:
 *   - `<CR><LF>` — line terminator (or `\n`; both accepted)
 *   - `<CR><LF>.<CR><LF>` — message terminator
 *
 * Dot-unstuffing: a `.` at the start of a line immediately followed by
 * another `.` is de-stuffed to a single `.`. A `.` alone on a line is
 * the message terminator. Any other leading `.` passes through.
 */

const LF = 0x0a;
const CR = 0x0d;
const DOT = 0x2e;

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export interface DataFeed {
  /** Unstuffed line contents (no CRLF), in order. */
  readonly lines: ReadonlyArray<Uint8Array>;
  /** Bytes after the terminator, to re-feed to command mode. */
  readonly remainder: Uint8Array | null;
}

export class DataParser {
  private remainder: Uint8Array | null = null;
  private done = false;
  private byteLength = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = Number.POSITIVE_INFINITY) {
    this.maxBytes = Number.isFinite(maxBytes)
      ? maxBytes
      : Number.POSITIVE_INFINITY;
  }

  feed(chunk: Uint8Array): DataFeed {
    if (this.done) {
      return { lines: [], remainder: chunk };
    }
    const buf = this.remainder ? concat(this.remainder, chunk) : chunk;
    this.remainder = null;
    const lines: Uint8Array[] = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(LF, pos);
      if (nl === -1) {
        this.remainder = buf.subarray(pos);
        break;
      }
      const lineEnd = nl > pos && buf[nl - 1] === CR ? nl - 1 : nl;
      let line = buf.subarray(pos, lineEnd);

      if (line.length > 0 && line[0] === DOT) {
        if (line.length === 1) {
          // `<CR><LF>.<CR><LF>` — message end.
          this.done = true;
          return { lines, remainder: buf.subarray(nl + 1) };
        }
        if (line[1] === DOT) {
          // `..` -> `.` (de-stuff).
          line = line.subarray(1);
        }
      }

      // Count the wire octets: line content plus its CRLF terminators.
      this.byteLength += line.length + 2;
      lines.push(line);
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

const sharedDecoder = new TextDecoder();

/** Decode an unstuffed line slice to a string (shared with the server). */
export const decodeLine = (line: Uint8Array): string =>
  sharedDecoder.decode(line);
