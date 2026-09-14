/**
 * RFC 2045 §6.7 quoted-printable encoding for SMTP bodies. Encodes any
 * byte outside the printable-ASCII range as `=HH` and folds lines at
 * 76 octets (we hard-cap at 76 to stay inside RFC 5322 §2.1.1 line
 * limits with headroom).
 */

const SOFT_LINE_BREAK = "=\r\n";

const isPrintableAscii = (b: number): boolean =>
  (b >= 33 && b <= 126 && b !== 61) || b === 9 || b === 32;

export const quotedPrintableEncode = (input: string | Uint8Array): string => {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let out = "";
  let lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    let piece: string;
    if (b === 13 && bytes[i + 1] === 10) {
      out += "\r\n";
      lineLen = 0;
      i++;
      continue;
    }
    if (b === 10) {
      out += "\r\n";
      lineLen = 0;
      continue;
    }
    if (isPrintableAscii(b)) {
      piece = String.fromCharCode(b);
    } else {
      piece = `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    if (lineLen + piece.length > 75) {
      out += SOFT_LINE_BREAK + piece;
      lineLen = piece.length;
    } else {
      out += piece;
      lineLen += piece.length;
    }
  }
  return out;
};
