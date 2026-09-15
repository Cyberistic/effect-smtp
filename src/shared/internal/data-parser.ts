/**
 * RFC 5321 §4.5.2 DATA mode parser.
 *
 * Fed raw TCP chunks, it emits the **body as raw byte segments** (the
 * accumulated chunks between dot-escape boundaries), plus the bytes that
 * trail the terminator for the caller's command-mode parser. It never
 * splits lines and never decodes — a no-op DATA handler allocates one
 * segment per socket chunk rather than one per 76-byte line.
 *
 * Only two sequences matter:
 *   - a `.` at the start of a line followed by `.` — de-stuff to one `.`
 *   - a `.` alone on a line — the message terminator
 *
 * Line splitting and UTF-8 decoding are the caller's, done on demand:
 * `splitLines` for `DataStream.lines`, or the raw bytes for
 * `DataStream.bytes`.
 */

const LF = 0x0a;
const CR = 0x0d;
const DOT = 0x2e;
const EMPTY = new Uint8Array(0);

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export interface DataFeed {
  /** Unstuffed body bytes, in order. Empty when nothing was emitted. */
  readonly body: ReadonlyArray<Uint8Array>;
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
    if (this.done) return { body: [], remainder: chunk };
    const buf = this.remainder ? concat(this.remainder, chunk) : chunk;
    this.remainder = null;
    const body: Uint8Array[] = [];
    const n = buf.length;
    let segStart = 0;
    let i = 0;
    let broke = false;

    /** Emit [segStart, end) as one unstuffed body segment. */
    const flush = (end: number): void => {
      if (end > segStart) {
        body.push(buf.subarray(segStart, end));
        this.byteLength += end - segStart;
      }
    };

    // `i` only ever sits at a line start (0, then just past each LF), so
    // the scan visits line starts via the native `indexOf` rather than
    // touching every byte in JS.
    while (i < n) {
      if (buf[i] === DOT) {
        if (i + 1 >= n) {
          // Not enough bytes to classify the dot — resume here next chunk.
          broke = true;
          break;
        }
        const next = buf[i + 1];
        if (next === DOT) {
          // `..` → `.`: drop the escape dot, keep the content dot.
          flush(i);
          segStart = i + 1;
          i += 1;
        } else if (next === CR || next === LF) {
          if (next === CR && i + 2 >= n) {
            broke = true;
            break;
          }
          if (next === LF || buf[i + 2] === LF) {
            flush(i);
            this.done = true;
            return {
              body,
              remainder: buf.subarray(next === CR ? i + 3 : i + 2),
            };
          }
        }
      }
      const nl = buf.indexOf(LF, i);
      if (nl === -1) {
        i = n;
        break;
      }
      i = nl + 1;
    }

    if (broke) {
      flush(i);
      this.remainder = buf.subarray(i);
    } else {
      flush(n);
    }
    return { body, remainder: null };
  }

  get bytes(): number {
    return this.byteLength;
  }

  get finished(): boolean {
    return this.done;
  }
}

/** Total length of a body's segments. */
export const bodyLength = (body: ReadonlyArray<Uint8Array>): number => {
  let total = 0;
  for (const seg of body) total += seg.length;
  return total;
};

/** Concatenate a body's segments into one buffer. */
export const joinBody = (body: ReadonlyArray<Uint8Array>): Uint8Array => {
  const first = body[0];
  if (first === undefined) return EMPTY;
  if (body.length === 1) return first;
  const out = new Uint8Array(bodyLength(body));
  let offset = 0;
  for (const seg of body) {
    out.set(seg, offset);
    offset += seg.length;
  }
  return out;
};

const decoder = new TextDecoder();

/** Split a body into decoded lines on CRLF or LF, dropping the trailing empty. */
export const splitLines = (body: Uint8Array): string[] => {
  if (body.length === 0) return [];
  const lines = decoder.decode(body).split(/\r\n|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};
