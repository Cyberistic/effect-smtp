import { describe, expect, it } from "vitest";
import { quotedPrintableEncode } from "../../src/shared/internal/quoted-printable.ts";

describe("quoted-printable", () => {
  it("passes through printable ASCII unchanged", () => {
    const out = quotedPrintableEncode("hello world");
    expect(out).toBe("hello world");
  });

  it("encodes non-ASCII as =HH", () => {
    const out = quotedPrintableEncode("héllo");
    expect(out).toBe("h=C3=A9llo");
  });

  it("encodes = as =3D", () => {
    const out = quotedPrintableEncode("a=b");
    expect(out).toBe("a=3Db");
  });

  it("folds lines longer than 75 octets", () => {
    const longLine = "x".repeat(200);
    const out = quotedPrintableEncode(longLine);
    expect(out).toContain("=\r\n");
    const segments = out.split("=\r\n");
    for (const seg of segments) {
      expect(seg.length).toBeLessThanOrEqual(75);
    }
  });

  it("preserves CRLF", () => {
    const out = quotedPrintableEncode("line one\r\nline two");
    expect(out).toBe("line one\r\nline two");
  });
});
