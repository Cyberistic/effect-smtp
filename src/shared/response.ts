import { Effect } from "effect";
import { SmtpParseError } from "./errors.ts";

/**
 * RFC 5321 §4.2 SMTP reply parsing. A reply is one or more lines:
 *   <code><sep><text>\r\n
 * where `<code>` is 3 digits, `<sep>` is `-` for continuation and ` `
 * for the terminal line. Every line of one reply shares the same code,
 * and the terminal line ends with a space (RFC 5321 §4.2.2).
 */
export interface SmtpReply {
  readonly code: number;
  readonly text: string;
  readonly enhancedCode?: string;
}

/**
 * Parse one ESMTP reply line into a `SmtpReply`. The ESMTP reply string
 * is hand-parsed (no schema); the parse is marked at the call site.
 *
 * Enhanced status codes (RFC 3463) live in the reply text as a leading
 * `<class>.<subject>.<detail>` triple (e.g. "2.1.0"); we extract them
 * opportunistically so callers can route on them.
 */
export const parseReplyLine = (line: string): SmtpReply => {
  if (line.length < 4) {
    return { code: 0, text: line };
  }
  const code = Number.parseInt(line.slice(0, 3), 10);
  if (Number.isNaN(code)) {
    return { code: 0, text: line };
  }
  const text = line.slice(4);
  const m = /^(\d\.\d\.\d)\s+/.exec(text);
  return m && m[1] ? { code, text, enhancedCode: m[1] } : { code, text };
};

/**
 * Read a full multi-line SMTP reply from the given line-source. The
 * caller passes a continuation step — `readLine` — which returns the
 * next raw reply line. The function reads continuation lines (`<code>-…`)
 * until it sees the terminal line (`<code> `).
 *
 * Errors from the underlying readLine (typically `SmtpConnectionClosed`)
 * are wrapped in `SmtpParseError` so the call-site can decide whether
 * to surface the parse error or treat it as an I/O error.
 */
export const readReply = <E>(
  readLine: Effect.Effect<string, E>,
): Effect.Effect<SmtpReply, SmtpParseError | E> =>
  Effect.gen(function* () {
    const first = yield* readLine;
    const head = parseReplyLine(first);
    if (first.length < 4 || head.code === 0) {
      return yield* Effect.fail(
        new SmtpParseError({ during: "readReply", raw: first }),
      );
    }
    if (first.charAt(3) === " ") {
      return head;
    }
    const rest: string[] = [];
    while (true) {
      const next = yield* readLine;
      const r = parseReplyLine(next);
      if (r.code !== head.code) {
        return yield* Effect.fail(
          new SmtpParseError({
            during: "readReply",
            raw: next,
          }),
        );
      }
      rest.push(r.text);
      if (next.charAt(3) === " ") {
        return { ...head, text: [head.text, ...rest].join("\r\n") };
      }
    }
  });
