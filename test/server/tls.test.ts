import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeServer, TestSmtpClient, type TestServer } from "./_harness.ts";
import { TLS_CERT, TLS_KEY } from "./_tls-fixture.ts";

const TLS = { key: TLS_KEY, cert: TLS_CERT };

describe("STARTTLS", () => {
  let server: TestServer | undefined;
  let client: TestSmtpClient | undefined;

  afterEach(async () => {
    client?.close();
    await server?.stop();
    server = undefined;
    client = undefined;
  });

  it("EHLO advertises STARTTLS when a certificate is configured", async () => {
    server = await makeServer({
      authOptional: true,
      tls: TLS,
      onData: () => Effect.void,
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    expect((await client.readAll()).join("\n")).toContain("STARTTLS");
  });

  it("STARTTLS is hidden when hideSTARTTLS is true", async () => {
    server = await makeServer({
      authOptional: true,
      tls: TLS,
      hideSTARTTLS: true,
      onData: () => Effect.void,
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    expect((await client.readAll()).join("\n")).not.toContain("STARTTLS");
  });

  it("STARTTLS is not advertised on a plain server", async () => {
    server = await makeServer({
      authOptional: true,
      onData: () => Effect.void,
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    expect((await client.readAll()).join("\n")).not.toContain("STARTTLS");
  });

  it("upgrades and stops advertising STARTTLS", async () => {
    server = await makeServer({
      authOptional: true,
      tls: TLS,
      onData: () => Effect.void,
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();

    client.send("STARTTLS");
    expect(await client.readResponse()).toMatch(/^220/);
    await client.upgradeTLS();

    client.send("EHLO localhost");
    expect((await client.readAll()).join("\n")).not.toContain("STARTTLS");
  });

  it("returns 503 when the connection is already TLS", async () => {
    server = await makeServer({
      authOptional: true,
      tls: TLS,
      onData: () => Effect.void,
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("STARTTLS");
    expect(await client.readResponse()).toMatch(/^220/);
    await client.upgradeTLS();

    client.send("STARTTLS");
    expect(await client.readResponse()).toMatch(/^503/);
  });

  it("runs a mail transaction after the upgrade and reports secure", async () => {
    let receivedBody = "";
    let sawSecure = false;
    server = await makeServer({
      authOptional: true,
      tls: TLS,
      onData: (stream, session) =>
        Effect.gen(function* () {
          sawSecure = session.secure;
          receivedBody = new TextDecoder().decode(yield* stream.bytes);
        }),
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("STARTTLS");
    expect(await client.readResponse()).toMatch(/^220/);
    await client.upgradeTLS();

    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<a@b.com>");
    expect(await client.readResponse()).toMatch(/^250/);
    client.send("RCPT TO:<c@d.com>");
    expect(await client.readResponse()).toMatch(/^250/);
    client.send("DATA");
    expect(await client.readResponse()).toMatch(/^354/);
    client.sendRaw("Subject: secure\r\n\r\nhello over tls\r\n.\r\n");
    expect(await client.readResponse()).toMatch(/^250/);

    expect(receivedBody).toContain("hello over tls");
    expect(sawSecure).toBe(true);
  });
});
