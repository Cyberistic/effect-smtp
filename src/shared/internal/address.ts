/**
 * Parse `MAIL FROM:<addr> [KEY=VAL ...]` and `RCPT TO:<addr> [KEY=VAL ...]`
 * (RFC 5321 §4.1.1.2 / §4.1.1.3), with the ESMTP parameter syntax of
 * RFC 1869 §6 and xtext decoding (RFC 3461 §4).
 *
 * Returns `null` when the command doesn't parse or the address is
 * invalid. A bounce address (`<>`) parses to `{ address: "" }`.
 */
import type { SmtpAddress } from "../envelope.ts";

/** Decode xtext: `+HH` hex escapes (RFC 3461 §4). */
const decodeXtext = (value: string): string =>
  value.replace(/\+([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

const isIPv4 = (s: string): boolean => {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return /^\d+$/.test(p) && n >= 0 && n <= 255;
  });
};

const isIPv6 = (s: string): boolean =>
  /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");

const isValidAddress = (address: string): boolean => {
  if (address === "") return true; // bounce address <>
  const atIdx = address.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === address.length - 1) return false;

  const localPart = address.slice(0, atIdx);
  const domain = address.slice(atIdx + 1);

  // RFC 5321 §4.5.3.1.1 local part max 64 octets, §4.5.3.1.3 path max 254.
  if (localPart.length > 64) return false;
  if (localPart.length + 1 + domain.length > 254) return false;
  if (
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return false;
  }

  if (domain.startsWith("[") && domain.endsWith("]")) {
    const inner = domain.slice(1, -1);
    return inner.toUpperCase().startsWith("IPV6:")
      ? isIPv6(inner.slice(5))
      : isIPv4(inner);
  }

  if (
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..") ||
    domain.includes(".-") ||
    domain.includes("-.")
  ) {
    return false;
  }
  return /^[a-zA-Z0-9\u0080-\uFFFF.-]+$/.test(domain);
};

export const parseAddressCommand = (
  name: string,
  command: string,
): SmtpAddress | null => {
  const colonIdx = command.indexOf(":");
  if (colonIdx === -1) return null;
  if (command.slice(0, colonIdx).trim().toUpperCase() !== name) return null;

  const parts = command
    .slice(colonIdx + 1)
    .trim()
    .split(/\s+/);
  const raw = parts.shift() ?? "";

  const bracket = /^<([^<>]*)>$/.exec(raw);
  if (!bracket) return null;
  const address = bracket[1] ?? "";

  const args: Record<string, string | boolean> = {};
  let hasArgs = false;
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).toUpperCase();
    if (key === "") continue;
    if (!hasArgs) hasArgs = true;
    args[key] = eq === -1 ? true : decodeXtext(part.slice(eq + 1));
  }

  if (!isValidAddress(address)) return null;

  return hasArgs ? { address, args } : { address };
};
