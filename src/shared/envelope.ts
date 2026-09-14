import * as Schema from "effect/Schema";

export const EmailAddress = Schema.Struct({
  email: Schema.String,
  name: Schema.optionalKey(Schema.String),
});

export type EmailAddress = Schema.Schema.Type<typeof EmailAddress>;

export const SmtpAuth = Schema.Union([
  Schema.Struct({
    method: Schema.Literals(["PLAIN", "LOGIN"]),
    identity: Schema.String,
    password: Schema.String,
  }),
  Schema.Struct({
    method: Schema.Literal("XOAUTH2"),
    identity: Schema.String,
    token: Schema.String,
  }),
] as const);

export type SmtpAuth = Schema.Schema.Type<typeof SmtpAuth>;

export const TlsOptions = Schema.Struct({
  starttls: Schema.optionalKey(Schema.Boolean),
  rejectUnauthorized: Schema.optionalKey(Schema.Boolean),
});

export type TlsOptions = Schema.Schema.Type<typeof TlsOptions>;

export const MakeSmtpClientOptions = Schema.Struct({
  host: Schema.String,
  port: Schema.optionalKey(Schema.Number),
  auth: Schema.optionalKey(SmtpAuth),
  tls: Schema.optionalKey(TlsOptions),
  timeoutMs: Schema.optionalKey(Schema.Number),
});

export type MakeSmtpClientOptions = Schema.Schema.Type<
  typeof MakeSmtpClientOptions
>;

export const Attachment = Schema.Struct({
  filename: Schema.String,
  contentType: Schema.String,
  body: Schema.String,
});

export type Attachment = Schema.Schema.Type<typeof Attachment>;

export const SendRequest = Schema.Struct({
  from: EmailAddress,
  to: Schema.Array(EmailAddress),
  cc: Schema.optionalKey(Schema.Array(EmailAddress)),
  bcc: Schema.optionalKey(Schema.Array(EmailAddress)),
  subject: Schema.String,
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
});

export type SendRequest = Schema.Schema.Type<typeof SendRequest>;

/**
 * ESMTP parameters (RFC 1869 §6): `KEY=value` pairs, plus bare flags
 * like `SMTPUTF8` which carry no value. xtext decoding has already been
 * applied by the parser.
 */
export const SmtpAddressArgs = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Boolean]),
);

export const SmtpAddress = Schema.Struct({
  address: Schema.String,
  args: Schema.optionalKey(SmtpAddressArgs),
});

export type SmtpAddress = Schema.Schema.Type<typeof SmtpAddress>;

export const SmtpEnvelope = Schema.Struct({
  mailFrom: Schema.optionalKey(SmtpAddress),
  rcptTo: Schema.Array(SmtpAddress),
});

export type SmtpEnvelope = Schema.Schema.Type<typeof SmtpEnvelope>;

export const SmtpSessionInfo = Schema.Struct({
  id: Schema.String,
  secure: Schema.Boolean,
  localAddress: Schema.String,
  localPort: Schema.Number,
  remoteAddress: Schema.String,
  remotePort: Schema.Number,
  clientHostname: Schema.String,
  openingCommand: Schema.String,
  envelope: SmtpEnvelope,
});

export type SmtpSessionInfo = Schema.Schema.Type<typeof SmtpSessionInfo>;
