/**
 * Benchmark target: smtp-server (the nodemailer SMTP server), run under
 * Node. Usage: `nub bench/servers/smtp-server.ts <port>`
 * Prints READY on stdout once listening.
 */
import { SMTPServer } from "smtp-server";

const port = Number(process.argv[2] ?? 0);

const server = new SMTPServer({
  authOptional: true,
  disableReverseLookup: true,
  onData(stream, _session, callback) {
    stream.on("data", () => undefined);
    stream.on("end", () => callback(null));
  },
});

server.listen(port, "127.0.0.1", () => {
  console.log("READY");
});
