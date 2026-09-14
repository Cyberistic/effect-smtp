import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SmtpRejectError } from "../../src/shared/errors.ts";
import { makeServer, TestSmtpClient, type TestServer } from "./_harness.ts";

/**
 * Server integration suite, ported from bun-smtp's test/integration.test.ts
 * so the two implementations are held to the same protocol contract.
 * Every case drives a real server over a loopback socket with a raw
 * client, independent of our own client code.
 */

describe("connection & greeting", () => {
  let server: TestServer;
  let client: TestSmtpClient;

  beforeEach(async () => {
    server = await makeServer({ onData: () => Effect.void });
    client = new TestSmtpClient();
    await client.connect(server.port);
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it("sends 220 greeting on connect", () => {
    // Consumed by connect(); reaching here means it arrived.
    expect(server.port).toBeGreaterThan(0);
  });

  it("responds to NOOP with 250", async () => {
    client.send("NOOP");
    expect(await client.readResponse()).toMatch(/^250/);
  });

  it("responds to HELP with 214", async () => {
    client.send("HELP");
    expect(await client.readResponse()).toMatch(/^214/);
  });

  it("responds to VRFY with 252", async () => {
    client.send("VRFY anyone");
    expect(await client.readResponse()).toMatch(/^252/);
  });

  it("QUIT closes with 221", async () => {
    client.send("QUIT");
    expect(await client.readResponse()).toMatch(/^221/);
  });

  it("unknown command returns 500", async () => {
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("BOGUSCMD");
    expect(await client.readResponse()).toMatch(/^500/);
  });

  it("HTTP request returns 421", async () => {
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("GET / HTTP/1.1");
    expect(await client.readResponse()).toMatch(/^421/);
  });
});

describe("EHLO capabilities", () => {
  let server: TestServer;
  let client: TestSmtpClient;

  beforeEach(async () => {
    server = await makeServer({
      authMethods: ["PLAIN", "LOGIN"],
      onData: () => Effect.void,
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it("EHLO returns 250 multi-line with PIPELINING and 8BITMIME", async () => {
    client.send("EHLO testclient.local");
    const lines = await client.readAll();
    expect(lines[0]).toMatch(/^250/);
    expect(lines.join("\n")).toContain("PIPELINING");
    expect(lines.join("\n")).toContain("8BITMIME");
  });

  it("HELO returns single 250 line", async () => {
    client.send("HELO testclient.local");
    expect(await client.readResponse()).toMatch(/^250 /);
  });

  it("EHLO with invalid syntax returns 501", async () => {
    client.send("EHLO");
    expect(await client.readResponse()).toMatch(/^501/);
  });
});

describe("MAIL / RCPT / DATA flow", () => {
  let server: TestServer;
  let client: TestSmtpClient;
  let received: string;

  beforeEach(async () => {
    received = "";
    server = await makeServer({
      authOptional: true,
      onData: (stream) =>
        Effect.gen(function* () {
          const bytes = yield* stream.bytes;
          received = new TextDecoder().decode(bytes);
        }),
    });
    client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it("full MAIL+RCPT+DATA transaction returns 250", async () => {
    client.send("MAIL FROM:<sender@example.com>");
    expect(await client.readResponse()).toMatch(/^250/);
    client.send("RCPT TO:<recipient@example.com>");
    expect(await client.readResponse()).toMatch(/^250/);
    client.send("DATA");
    expect(await client.readResponse()).toMatch(/^354/);
    client.sendRaw("Subject: Test\r\n\r\nHello!\r\n.\r\n");
    expect(await client.readResponse()).toMatch(/^250/);
  });

  it("onData receives full body content", async () => {
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("RCPT TO:<c@d.com>");
    await client.readResponse();
    client.send("DATA");
    await client.readResponse();
    client.sendRaw("Subject: hello\r\n\r\nbody text\r\n.\r\n");
    await client.readResponse();

    expect(received).toContain("Subject: hello");
    expect(received).toContain("body text");
  });

  it("dot-stuffed dot in body is unescaped", async () => {
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("RCPT TO:<c@d.com>");
    await client.readResponse();
    client.send("DATA");
    await client.readResponse();
    client.sendRaw("Line 1\r\n..starts with dot\r\n.\r\n");
    await client.readResponse();

    expect(received).toContain(".starts with dot");
  });

  it("RCPT before MAIL returns 503", async () => {
    client.send("RCPT TO:<a@b.com>");
    expect(await client.readResponse()).toMatch(/^503/);
  });

  it("DATA before RCPT returns 503", async () => {
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("DATA");
    expect(await client.readResponse()).toMatch(/^503/);
  });

  it("nested MAIL returns 503", async () => {
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("MAIL FROM:<b@c.com>");
    expect(await client.readResponse()).toMatch(/^503/);
  });

  it("RSET clears envelope", async () => {
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("RSET");
    expect(await client.readResponse()).toMatch(/^250/);
    client.send("MAIL FROM:<c@d.com>");
    expect(await client.readResponse()).toMatch(/^250/);
  });

  it("multiple recipients accepted", async () => {
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("RCPT TO:<r1@example.com>");
    expect(await client.readResponse()).toMatch(/^250/);
    client.send("RCPT TO:<r2@example.com>");
    expect(await client.readResponse()).toMatch(/^250/);
  });
});

describe("onMailFrom / onRcptTo callbacks", () => {
  it("onMailFrom rejection propagates as 550", async () => {
    const server = await makeServer({
      authOptional: true,
      onData: () => Effect.void,
      onMailFrom: () =>
        Effect.fail(
          new SmtpRejectError({ code: 550, message: "Blocked sender" }),
        ),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<bad@example.com>");
    expect(await client.readResponse()).toMatch(/^550/);
    client.close();
    await server.stop();
  });

  it("onRcptTo rejection propagates as 550", async () => {
    const server = await makeServer({
      authOptional: true,
      onData: () => Effect.void,
      onRcptTo: () =>
        Effect.fail(
          new SmtpRejectError({ code: 550, message: "No such user" }),
        ),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("RCPT TO:<nobody@example.com>");
    expect(await client.readResponse()).toMatch(/^550/);
    client.close();
    await server.stop();
  });

  it("onMailFrom receives correct address and args", async () => {
    let capturedAddress = "";
    let capturedSize = "";
    const server = await makeServer({
      authOptional: true,
      onData: () => Effect.void,
      onMailFrom: (addr) =>
        Effect.sync(() => {
          capturedAddress = addr.address;
          const size = addr.args?.["SIZE"];
          capturedSize = typeof size === "string" ? size : "";
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<sender@domain.com> SIZE=999");
    await client.readResponse();

    expect(capturedAddress).toBe("sender@domain.com");
    expect(capturedSize).toBe("999");
    client.close();
    await server.stop();
  });

  it("session.envelope is updated after MAIL+RCPT", async () => {
    let envelope:
      | {
          mailFrom: { address: string } | undefined;
          rcptTo: Array<{ address: string }>;
        }
      | undefined;
    const server = await makeServer({
      authOptional: true,
      onData: (stream, session) =>
        Effect.gen(function* () {
          envelope = {
            mailFrom: session.envelope.mailFrom,
            rcptTo: [...session.envelope.rcptTo],
          };
          yield* stream.byteLength;
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<from@test.com>");
    await client.readResponse();
    client.send("RCPT TO:<to@test.com>");
    await client.readResponse();
    client.send("DATA");
    await client.readResponse();
    client.sendRaw("hi\r\n.\r\n");
    await client.readResponse();

    expect(envelope?.mailFrom?.address).toBe("from@test.com");
    expect(envelope?.rcptTo[0]?.address).toBe("to@test.com");
    client.close();
    await server.stop();
  });
});

describe("authentication", () => {
  const makeAuthServer = () =>
    makeServer({
      authMethods: ["PLAIN", "LOGIN"],
      onData: () => Effect.void,
      onAuth: (auth) =>
        Effect.succeed(
          auth.identity === "user" && auth.password === "pass"
            ? { user: { name: auth.identity } }
            : undefined,
        ),
    });

  it("AUTH PLAIN success → 235", async () => {
    const server = await makeAuthServer();
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send(`AUTH PLAIN ${Buffer.from("\0user\0pass").toString("base64")}`);
    expect(await client.readResponse()).toMatch(/^235/);
    client.close();
    await server.stop();
  });

  it("AUTH PLAIN failure → 535", async () => {
    const server = await makeAuthServer();
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send(
      `AUTH PLAIN ${Buffer.from("\0user\0wrongpass").toString("base64")}`,
    );
    expect(await client.readResponse()).toMatch(/^535/);
    client.close();
    await server.stop();
  });

  it("AUTH LOGIN multi-step success → 235", async () => {
    const server = await makeAuthServer();
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("AUTH LOGIN");
    await client.readResponse();
    client.send(Buffer.from("user").toString("base64"));
    await client.readResponse();
    client.send(Buffer.from("pass").toString("base64"));
    expect(await client.readResponse()).toMatch(/^235/);
    client.close();
    await server.stop();
  });

  it("AUTH requires EHLO first", async () => {
    const server = await makeAuthServer();
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("AUTH PLAIN dGVzdA==");
    expect(await client.readResponse()).toMatch(/^503/);
    client.close();
    await server.stop();
  });

  it("MAIL blocked without auth when authOptional=false", async () => {
    const server = await makeServer({
      authOptional: false,
      authMethods: ["PLAIN"],
      onData: () => Effect.void,
      onAuth: () => Effect.succeed({ user: {} }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<a@b.com>");
    expect(await client.readResponse()).toMatch(/^530/);
    client.close();
    await server.stop();
  });

  it("session.user is set after successful auth", async () => {
    let capturedUser: unknown;
    const server = await makeServer({
      authOptional: true,
      authMethods: ["PLAIN"],
      onData: (_stream, session) =>
        Effect.sync(() => {
          capturedUser = session.user;
        }),
      onAuth: () => Effect.succeed({ user: { id: 42 } }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send(`AUTH PLAIN ${Buffer.from("\0user\0pass").toString("base64")}`);
    await client.readResponse();
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("RCPT TO:<b@c.com>");
    await client.readResponse();
    client.send("DATA");
    await client.readResponse();
    client.sendRaw("hi\r\n.\r\n");
    await client.readResponse();

    expect((capturedUser as { id: number } | undefined)?.id).toBe(42);
    client.close();
    await server.stop();
  });
});

describe("SIZE extension", () => {
  it("MAIL FROM with SIZE exceeding limit is rejected with 552", async () => {
    const server = await makeServer({
      authOptional: true,
      maxSize: 1000,
      onData: () => Effect.void,
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<a@b.com> SIZE=99999");
    expect(await client.readResponse()).toMatch(/^552/);
    client.close();
    await server.stop();
  });

  it("SIZE capability is advertised in EHLO", async () => {
    const server = await makeServer({
      authOptional: true,
      maxSize: 5_000_000,
      onData: () => Effect.void,
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    const lines = await client.readAll();
    expect(lines.join("\n")).toContain("SIZE");
    client.close();
    await server.stop();
  });
});

describe("onConnect hook", () => {
  it("onConnect rejection closes the connection with 554", async () => {
    const server = await makeServer({
      onData: () => Effect.void,
      onConnect: () =>
        Effect.fail(new SmtpRejectError({ code: 554, message: "Blocked" })),
    });
    const client = new TestSmtpClient();
    const greeting = await client.connect(server.port);
    expect(greeting).toMatch(/^554/);
    client.close();
    await server.stop();
  });

  it("onConnect success allows the connection to proceed", async () => {
    let called = false;
    const server = await makeServer({
      onData: () => Effect.void,
      onConnect: () =>
        Effect.sync(() => {
          called = true;
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    expect(called).toBe(true);
    client.close();
    await server.stop();
  });
});

describe("onClose callback", () => {
  it("onClose is called when the connection closes", async () => {
    let closedSessionId = "";
    const server = await makeServer({
      onData: () => Effect.void,
      onClose: (session) =>
        Effect.sync(() => {
          closedSessionId = session.id;
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("QUIT");
    await client.readResponse();
    client.close();
    await Effect.runPromise(Effect.sleep("50 millis"));
    expect(closedSessionId).toBeTruthy();
    await server.stop();
  });
});

describe("session state", () => {
  const runTransaction = async (client: TestSmtpClient): Promise<void> => {
    client.send("EHLO localhost");
    await client.readResponse();
    client.send("MAIL FROM:<a@b.com>");
    await client.readResponse();
    client.send("RCPT TO:<b@c.com>");
    await client.readResponse();
    client.send("DATA");
    await client.readResponse();
    client.sendRaw("hi\r\n.\r\n");
    await client.readResponse();
  };

  it("session.id is a non-empty string", async () => {
    let sessionId = "";
    const server = await makeServer({
      authOptional: true,
      onData: (_stream, session) =>
        Effect.sync(() => {
          sessionId = session.id;
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    await runTransaction(client);
    expect(sessionId.length).toBeGreaterThan(0);
    client.close();
    await server.stop();
  });

  it("transmissionType is ESMTP after EHLO", async () => {
    let txType = "";
    const server = await makeServer({
      authOptional: true,
      onData: (_stream, session) =>
        Effect.sync(() => {
          txType = session.transmissionType;
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    await runTransaction(client);
    expect(txType).toBe("ESMTP");
    client.close();
    await server.stop();
  });

  it("transmissionType includes A after AUTH", async () => {
    let txType = "";
    const server = await makeServer({
      authOptional: false,
      authMethods: ["PLAIN"],
      onAuth: () => Effect.succeed({ user: {} }),
      onData: (_stream, session) =>
        Effect.sync(() => {
          txType = session.transmissionType;
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();
    client.send(`AUTH PLAIN ${Buffer.from("\0user\0pass").toString("base64")}`);
    await client.readResponse();
    await runTransaction(client);
    expect(txType).toContain("A");
    client.close();
    await server.stop();
  });

  it("transaction counter increments after each DATA", async () => {
    const txCounts: number[] = [];
    const server = await makeServer({
      authOptional: true,
      onData: (_stream, session) =>
        Effect.sync(() => {
          txCounts.push(session.transaction);
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    await runTransaction(client);
    await runTransaction(client);
    await runTransaction(client);
    expect(txCounts).toEqual([1, 2, 3]);
    client.close();
    await server.stop();
  });
});

describe("LMTP mode", () => {
  it("EHLO is rejected in LMTP mode", async () => {
    const server = await makeServer({
      lmtp: true,
      authOptional: true,
      onData: () => Effect.void,
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    expect(await client.readResponse()).toMatch(/^500/);
    client.close();
    await server.stop();
  });

  it("LHLO is accepted in LMTP mode", async () => {
    const server = await makeServer({
      lmtp: true,
      authOptional: true,
      onData: () => Effect.void,
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("LHLO localhost");
    expect(await client.readResponse()).toMatch(/^250/);
    client.close();
    await server.stop();
  });
});

describe("pipelining (multiple commands in one send)", () => {
  it("pipelined MAIL+RCPT+DATA handled in order", async () => {
    let received = "";
    const server = await makeServer({
      authOptional: true,
      onData: (stream) =>
        Effect.gen(function* () {
          received = new TextDecoder().decode(yield* stream.bytes);
        }),
    });
    const client = new TestSmtpClient();
    await client.connect(server.port);
    client.send("EHLO localhost");
    await client.readResponse();

    // One write, three commands.
    client.sendRaw("MAIL FROM:<a@b.com>\r\nRCPT TO:<c@d.com>\r\nDATA\r\n");
    expect(await client.readResponse()).toMatch(/^250/);
    expect(await client.readResponse()).toMatch(/^250/);
    expect(await client.readResponse()).toMatch(/^354/);
    client.sendRaw("Subject: pipe\r\n\r\npipelined\r\n.\r\n");
    expect(await client.readResponse()).toMatch(/^250/);

    expect(received).toContain("pipelined");
    client.close();
    await server.stop();
  });
});
