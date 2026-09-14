import * as Schema from "effect/Schema";

export class SmtpError extends Schema.TaggedError<SmtpError>()(
  "effect-smtp/SmtpError",
  {
    kind: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export class SmtpAuthError extends Schema.TaggedError<SmtpAuthError>()(
  "effect-smtp/SmtpAuthError",
  {
    response: Schema.String,
  },
) {}

export class SmtpGreetingError extends Schema.TaggedError<SmtpGreetingError>()(
  "effect-smtp/SmtpGreetingError",
  {
    raw: Schema.String,
  },
) {}

export class SmtpTlsError extends Schema.TaggedError<SmtpTlsError>()(
  "effect-smtp/SmtpTlsError",
  {
    stage: Schema.Literals(["wrap", "handshake"]),
  },
) {}

export class SmtpConnectionClosed extends Schema.TaggedError<SmtpConnectionClosed>()(
  "effect-smtp/SmtpConnectionClosed",
  {
    during: Schema.String,
  },
) {}

export class SmtpParseError extends Schema.TaggedError<SmtpParseError>()(
  "effect-smtp/SmtpParseError",
  {
    during: Schema.String,
    raw: Schema.String,
  },
) {}

export class SmtpRejectError extends Schema.TaggedError<SmtpRejectError>()(
  "effect-smtp/SmtpRejectError",
  {
    code: Schema.Number,
    message: Schema.String,
  },
) {}
