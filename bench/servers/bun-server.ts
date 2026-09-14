/**
 * Benchmark target: bun-smtp (the reference). Must run under Bun:
 *   bun bench/servers/bun-server.ts <port>
 * Prints READY on stdout once listening.
 */
import { SMTPServer } from "../../references/bun-smtp/src/smtp-server.ts";

const port = Number(process.argv[2] ?? 0);

const server = new SMTPServer({
  authOptional: true,
  disableReverseLookup: true,
  async onData(stream, _session, callback) {
    for await (const _chunk of stream) {
      // drain and discard
    }
    callback(null);
  },
});

server.listen(port, "127.0.0.1", () => {
  console.log("READY");
});
