import { describe, expect, it } from "vitest";
import {
  DataParser,
  joinBody,
  splitLines,
} from "../../src/shared/internal/data-parser.ts";

const b = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

interface Collected {
  /** The unstuffed body, as bytes. */
  readonly body: string;
  /** The unstuffed body, split into decoded lines. */
  readonly lines: ReadonlyArray<string>;
  readonly byteLength: number;
  readonly remainder: string | null;
}

/** Feed chunks through a fresh parser and collect body + remainder. */
const collect = (chunks: ReadonlyArray<string>, maxBytes = 0): Collected => {
  const parser = new DataParser(maxBytes);
  const segments: Uint8Array[] = [];
  let remainder: string | null = null;
  for (const chunk of chunks) {
    const feed = parser.feed(b(chunk));
    for (const segment of feed.body) segments.push(segment);
    if (feed.remainder) remainder = dec(feed.remainder);
  }
  const body = joinBody(segments);
  return {
    body: dec(body),
    lines: splitLines(body),
    byteLength: parser.bytes,
    remainder,
  };
};

describe("DataParser — basics", () => {
  it("simple message, all in one chunk", () => {
    const r = collect(["Subject: hi\r\n\r\nHello world\r\n.\r\n"]);
    expect(r.lines).toEqual(["Subject: hi", "", "Hello world"]);
    expect(r.byteLength).toBe(28);
  });

  it("empty message (terminator immediately)", () => {
    const r = collect([".\r\n"]);
    expect(r.body).toBe("");
    expect(r.lines).toEqual([]);
    expect(r.byteLength).toBe(0);
  });

  it("message split across many small chunks", () => {
    const full = "Line one\r\nLine two\r\n.\r\n";
    const r = collect(full.split(""));
    expect(r.lines).toEqual(["Line one", "Line two"]);
  });

  it("terminator split across a chunk boundary", () => {
    const r = collect(["Hello\r\n", ".\r", "\n"]);
    expect(r.lines).toEqual(["Hello"]);
  });

  it("accepts LF-only line endings", () => {
    const r = collect(["Header\nbody\n.\n"]);
    expect(r.lines).toEqual(["Header", "body"]);
  });

  it("emits one body segment for a dot-free chunk (no per-line slicing)", () => {
    const parser = new DataParser();
    const big = `${"x".repeat(76)}\r\n`.repeat(100) + ".\r\n";
    const feed = parser.feed(b(big));
    expect(feed.body.length).toBe(1);
  });
});

describe("DataParser — dot-unstuffing", () => {
  it("dot-stuffed dot in the middle of a message", () => {
    const r = collect(["Line 1\r\n..dotline\r\n.\r\n"]);
    expect(r.body).toBe("Line 1\r\n.dotline\r\n");
    expect(r.lines).toEqual(["Line 1", ".dotline"]);
  });

  it("dot-stuffed dot split across a chunk boundary", () => {
    const r = collect(["Line 1\r\n.", ".dotline\r\n.\r\n"]);
    expect(r.lines).toEqual(["Line 1", ".dotline"]);
  });

  it("multiple dot-stuffed lines", () => {
    const r = collect(["..first\r\n..second\r\n.\r\n"]);
    expect(r.body).toBe(".first\r\n.second\r\n");
    expect(r.lines).toEqual([".first", ".second"]);
  });

  it("a dot-stuffed line at the very start of the body", () => {
    const r = collect(["..leading\r\n.\r\n"]);
    expect(r.body).toBe(".leading\r\n");
  });

  it("a leading dot not followed by a dot is passed through", () => {
    const r = collect([".leading\r\n.\r\n"]);
    expect(r.lines).toEqual([".leading"]);
  });
});

describe("DataParser — size accounting", () => {
  it("counts wire octets including CRLF (RFC 1870 SIZE)", () => {
    const r = collect(["short\r\n.\r\n"]);
    expect(r.byteLength).toBe(7);
  });

  it("reports a body larger than the limit via byteLength", () => {
    const parser = new DataParser(5);
    parser.feed(b("1234567\r\n.\r\n"));
    expect(parser.bytes).toBeGreaterThan(5);
    expect(parser.finished).toBe(true);
  });

  it("does not double-count bytes held over a chunk boundary", () => {
    const parser = new DataParser();
    // The final "." is incomplete, so it is held over — its byte must not
    // be counted until the next chunk classifies it.
    parser.feed(b("hi\r\n."));
    const afterFirst = parser.bytes;
    parser.feed(b("\r\n"));
    expect(afterFirst).toBe(4); // "hi\r\n"
    expect(parser.bytes).toBe(4);
  });
});

describe("DataParser — post-terminator remainder", () => {
  it("bytes after the terminator are returned as remainder", () => {
    const r = collect(["body\r\n.\r\nRSET\r\n"]);
    expect(r.remainder).toBe("RSET\r\n");
  });
});
