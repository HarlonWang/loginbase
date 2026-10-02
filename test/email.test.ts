import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { sendCodeEmail, type EmailConfig, type EmailSender } from "../src/email";

describe("sendCodeEmail", () => {
  it("把渲染好的邮件交给 send，邮件对象恰为 from / to / subject / html / text", async () => {
    const send = vi.fn<EmailSender>(async () => {});
    const config: EmailConfig = { send, from: env.EMAIL_FROM_ADDRESS, brand: "Tono" };
    await sendCodeEmail(config, "u@x.com", "123456");
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0][0];
    expect(Object.keys(message).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(message.from).toBe(env.EMAIL_FROM_ADDRESS);
    expect(message.to).toBe("u@x.com");
    expect(message.subject).toContain("Tono");
    expect(message.html).toContain("123456");
    expect(message.text).toContain("123456");
  });

  it("send 抛错 → sendCodeEmail 抛错", async () => {
    const config: EmailConfig = {
      send: async () => { throw new Error("ses down"); },
      from: env.EMAIL_FROM_ADDRESS,
    };
    await expect(sendCodeEmail(config, "u@x.com", "123456")).rejects.toThrow("ses down");
  });
});
