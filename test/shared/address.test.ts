import { describe, expect, it } from "vitest";
import { parseAddressCommand } from "../../src/shared/internal/address.ts";

describe("parseAddressCommand — MAIL FROM", () => {
  it("basic address", () => {
    const r = parseAddressCommand("MAIL FROM", "MAIL FROM:<user@example.com>");
    expect(r).toEqual({ address: "user@example.com" });
  });

  it("case-insensitive prefix", () => {
    const r = parseAddressCommand("MAIL FROM", "mail from:<user@example.com>");
    expect(r?.address).toBe("user@example.com");
  });

  it("with SIZE parameter", () => {
    const r = parseAddressCommand(
      "MAIL FROM",
      "MAIL FROM:<a@b.com> SIZE=12345",
    );
    expect(r?.args?.["SIZE"]).toBe("12345");
  });

  it("with BODY=8BITMIME parameter", () => {
    const r = parseAddressCommand(
      "MAIL FROM",
      "MAIL FROM:<a@b.com> BODY=8BITMIME",
    );
    expect(r?.args?.["BODY"]).toBe("8BITMIME");
  });

  it("with SMTPUTF8 flag (no value)", () => {
    const r = parseAddressCommand("MAIL FROM", "MAIL FROM:<a@b.com> SMTPUTF8");
    expect(r?.args?.["SMTPUTF8"]).toBe(true);
  });

  it("empty bounce address <>", () => {
    const r = parseAddressCommand("MAIL FROM", "MAIL FROM:<>");
    expect(r).toEqual({ address: "" });
  });

  it("multiple parameters", () => {
    const r = parseAddressCommand(
      "MAIL FROM",
      "MAIL FROM:<a@b.com> SIZE=100 BODY=7BIT",
    );
    expect(r?.args?.["SIZE"]).toBe("100");
    expect(r?.args?.["BODY"]).toBe("7BIT");
  });

  it("xtext-encoded parameter value", () => {
    const r = parseAddressCommand(
      "MAIL FROM",
      "MAIL FROM:<a@b.com> ENVID=foo+2Bbar",
    );
    expect(r?.args?.["ENVID"]).toBe("foo+bar");
  });
});

describe("parseAddressCommand — RCPT TO", () => {
  it("basic address", () => {
    const r = parseAddressCommand("RCPT TO", "RCPT TO:<recipient@example.com>");
    expect(r?.address).toBe("recipient@example.com");
  });

  it("with NOTIFY parameter", () => {
    const r = parseAddressCommand(
      "RCPT TO",
      "RCPT TO:<a@b.com> NOTIFY=SUCCESS,FAILURE",
    );
    expect(r?.args?.["NOTIFY"]).toBe("SUCCESS,FAILURE");
  });

  it("with ORCPT parameter", () => {
    const r = parseAddressCommand(
      "RCPT TO",
      "RCPT TO:<a@b.com> ORCPT=rfc822;original@example.com",
    );
    expect(r?.args?.["ORCPT"]).toBe("rfc822;original@example.com");
  });
});

describe("parseAddressCommand — invalid inputs", () => {
  it("wrong prefix returns null", () => {
    expect(parseAddressCommand("MAIL FROM", "RCPT TO:<a@b.com>")).toBeNull();
  });

  it("missing colon returns null", () => {
    expect(parseAddressCommand("MAIL FROM", "MAIL FROM <a@b.com>")).toBeNull();
  });

  it("missing angle brackets returns null", () => {
    expect(
      parseAddressCommand("MAIL FROM", "MAIL FROM:user@example.com"),
    ).toBeNull();
  });

  it("address without @ returns null", () => {
    expect(parseAddressCommand("MAIL FROM", "MAIL FROM:<nodomain>")).toBeNull();
  });

  it("address with leading dot in local part returns null", () => {
    expect(
      parseAddressCommand("MAIL FROM", "MAIL FROM:<.user@example.com>"),
    ).toBeNull();
  });

  it("address with trailing dot in local part returns null", () => {
    expect(
      parseAddressCommand("MAIL FROM", "MAIL FROM:<user.@example.com>"),
    ).toBeNull();
  });

  it("address with consecutive dots returns null", () => {
    expect(
      parseAddressCommand("MAIL FROM", "MAIL FROM:<u..r@example.com>"),
    ).toBeNull();
  });

  it("address exceeding 254 chars returns null", () => {
    const longLocal = "a".repeat(240);
    expect(
      parseAddressCommand("MAIL FROM", `MAIL FROM:<${longLocal}@b.com>`),
    ).toBeNull();
  });

  it("local part exceeding 64 octets returns null", () => {
    const local = "a".repeat(65);
    expect(
      parseAddressCommand("MAIL FROM", `MAIL FROM:<${local}@b.com>`),
    ).toBeNull();
  });

  it("empty input returns null", () => {
    expect(parseAddressCommand("MAIL FROM", "")).toBeNull();
  });

  it("accepts an IPv4 address literal domain", () => {
    const r = parseAddressCommand("MAIL FROM", "MAIL FROM:<a@[127.0.0.1]>");
    expect(r?.address).toBe("a@[127.0.0.1]");
  });

  it("accepts an IPv6 address literal domain", () => {
    const r = parseAddressCommand(
      "MAIL FROM",
      "MAIL FROM:<a@[IPv6:2001:db8::1]>",
    );
    expect(r?.address).toBe("a@[IPv6:2001:db8::1]");
  });

  it("rejects a malformed IPv4 address literal", () => {
    expect(
      parseAddressCommand("MAIL FROM", "MAIL FROM:<a@[999.0.0.1]>"),
    ).toBeNull();
  });
});
