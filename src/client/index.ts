export { SmtpClient, makeSmtpClient, type SmtpClientShape } from "./service.ts";
export {
  authLogin,
  authPlain,
  authXOauth2,
  expectClass,
  sendDataBody,
  startTls,
} from "./auth-data.ts";
export { connectSmtp, ehlo, expectReply, writeCommand } from "./effects.ts";
