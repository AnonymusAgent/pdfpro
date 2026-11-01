/**
 * Transactional email delivery.
 *
 * Three transports are supported, in this order of preference:
 *   smtp     – any SMTP provider (Postmark, SES, Mailgun, Zoho, Gmail app password…)
 *   resend   – Resend HTTP API
 *   console  – writes to the `email_outbox` table and the server log
 *
 * Every message is recorded in `email_outbox` so the administrator can recover
 * a verification or reset link if a transport is misconfigured. Message bodies
 * never contain secrets other than the single-use link they were created for.
 */
import { db } from "@/db";
import { emailOutbox } from "@/db/schema";
import { config } from "./config";
import { sanitizeText } from "./crypto";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: string;
};

export type EmailResult = { delivered: boolean; transport: string; error?: string };

async function deliverSmtp(message: EmailMessage): Promise<EmailResult> {
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transport = config.email.smtpUrl
      ? nodemailer.createTransport(config.email.smtpUrl)
      : nodemailer.createTransport({
          host: config.email.smtpHost,
          port: config.email.smtpPort,
          secure: config.email.smtpSecure,
          auth: config.email.smtpUser ? { user: config.email.smtpUser, pass: config.email.smtpPass } : undefined,
        });
    await transport.sendMail({
      from: config.email.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { delivered: true, transport: "smtp" };
  } catch (error) {
    return { delivered: false, transport: "smtp", error: error instanceof Error ? error.message : "SMTP failure" };
  }
}

async function deliverResend(message: EmailMessage): Promise<EmailResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { delivered: false, transport: "resend", error: `Resend ${response.status}: ${detail.slice(0, 200)}` };
    }
    return { delivered: true, transport: "resend" };
  } catch (error) {
    return { delivered: false, transport: "resend", error: error instanceof Error ? error.message : "Resend failure" };
  }
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const to = sanitizeText(message.to, 320).toLowerCase();
  const subject = sanitizeText(message.subject, 200) || "PDF Pro notification";
  let result: EmailResult;

  if (config.email.transport === "smtp") {
    result = await deliverSmtp({ ...message, to, subject });
  } else if (config.email.transport === "resend") {
    result = await deliverResend({ ...message, to, subject });
  } else {
    console.info(`[email:console] to=${to} subject=${subject}\n${message.text}\n`);
    result = { delivered: true, transport: "console" };
  }

  try {
    await db.insert(emailOutbox).values({
      toEmail: to,
      subject,
      bodyText: message.text.slice(0, 20000),
      kind: sanitizeText(message.kind, 64) || "generic",
      transport: result.transport,
      status: result.delivered ? "sent" : "failed",
      error: result.error?.slice(0, 500) ?? null,
      sentAt: result.delivered ? new Date() : null,
    });
  } catch (error) {
    console.error("[email] could not record outbox entry", error);
  }

  return result;
}
