/**
 * RFC 4648 §4 base64. Strips padding for SASL PLAIN/XOAUTH2 initial
 * response (RFC 4954 §4); callers can opt back into padding by passing
 * `{ padded: true }`.
 */
export const encodeBase64 = (
  input: string | Uint8Array,
  options?: { readonly padded?: boolean },
): string => {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += ALPHABET[(triple >> 18) & 0x3f];
    out += ALPHABET[(triple >> 12) & 0x3f];
    if (b1 !== undefined) {
      out += ALPHABET[(triple >> 6) & 0x3f];
      if (b2 !== undefined) {
        out += ALPHABET[triple & 0x3f];
      } else if (options?.padded) {
        out += "=";
      }
    } else if (options?.padded) {
      out += "==";
    }
  }
  return out;
};

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const decodeBase64 = (input: string): Uint8Array => {
  const clean = input.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let oi = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = REV[clean.charCodeAt(i)] ?? 0;
    const c1 = REV[clean.charCodeAt(i + 1)] ?? 0;
    const c2 =
      clean.charCodeAt(i + 2) === 61 ? 0 : (REV[clean.charCodeAt(i + 2)] ?? 0);
    const c3 =
      clean.charCodeAt(i + 3) === 61 ? 0 : (REV[clean.charCodeAt(i + 3)] ?? 0);
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[oi++] = (triple >> 16) & 0xff;
    if (clean.charCodeAt(i + 2) !== 61) {
      out[oi++] = (triple >> 8) & 0xff;
    }
    if (clean.charCodeAt(i + 3) !== 61) {
      out[oi++] = triple & 0xff;
    }
  }
  return out;
};

const REV: Record<number, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  REV[ALPHABET.charCodeAt(i)] = i;
}
