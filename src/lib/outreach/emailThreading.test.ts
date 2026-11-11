import { describe, expect, test } from "bun:test";

import { inboundThreadRoot, newMessageId, parseMessageIdList, smtpSendThreadId } from "./emailThreading";

describe("parseMessageIdList", () => {
  test("reads every bracketed id in order", () => {
    expect(parseMessageIdList("<a@x.com> <b@x.com>\r\n <c@y.org>")).toEqual(["<a@x.com>", "<b@x.com>", "<c@y.org>"]);
  });
  test("accepts the array form mailparser gives for several references", () => {
    expect(parseMessageIdList(["<a@x.com>", "<b@x.com>"])).toEqual(["<a@x.com>", "<b@x.com>"]);
  });
  test("brackets a bare id", () => {
    expect(parseMessageIdList("a@x.com")).toEqual(["<a@x.com>"]);
  });
  test("is empty for nothing", () => {
    expect(parseMessageIdList(undefined)).toEqual([]);
    expect(parseMessageIdList("")).toEqual([]);
  });
});

describe("newMessageId", () => {
  test("uses the sender's domain", () => {
    expect(newMessageId("Rep@Acme.IO", () => "123")).toBe("<123@acme.io>");
  });
});

describe("smtpSendThreadId", () => {
  test("a first email starts its own thread", () => {
    expect(smtpSendThreadId({}, "<m1@acme.io>")).toBe("<m1@acme.io>");
  });
  test("a follow-up keeps the thread it was given", () => {
    expect(smtpSendThreadId({ threadId: "<m1@acme.io>", references: ["<m1@acme.io>", "<m2@acme.io>"] }, "<m3@acme.io>")).toBe("<m1@acme.io>");
  });
  test("a reply without a thread id joins the root of its references", () => {
    expect(smtpSendThreadId({ references: ["<root@lead.com>", "<r2@acme.io>"], inReplyTo: "<r2@acme.io>" }, "<m@acme.io>")).toBe("<root@lead.com>");
  });
});

describe("inboundThreadRoot", () => {
  test("a reply to our first email is in the thread our send named", () => {
    const sentId = "<m1@acme.io>";
    const threadOfSend = smtpSendThreadId({}, sentId);
    const reply = inboundThreadRoot({ references: [sentId], inReplyTo: sentId, messageId: "<r1@lead.com>" });
    expect(reply.root).toBe(threadOfSend);
  });
  test("a reply deep in a thread still names its root", () => {
    expect(inboundThreadRoot({ references: ["<m1@acme.io>", "<r1@lead.com>", "<m2@acme.io>"], inReplyTo: "<m2@acme.io>" }).root).toBe("<m1@acme.io>");
  });
  test("falls back to In-Reply-To, then to itself", () => {
    expect(inboundThreadRoot({ inReplyTo: "<m1@acme.io>", messageId: "<r@lead.com>" }).root).toBe("<m1@acme.io>");
    expect(inboundThreadRoot({ messageId: "<new@lead.com>" }).root).toBe("<new@lead.com>");
  });
  test("offers every referenced id as a candidate once", () => {
    expect(inboundThreadRoot({ references: ["<a@x>", "<b@x>"], inReplyTo: "<b@x>" }).candidates).toEqual(["<a@x>", "<b@x>"]);
  });
});
