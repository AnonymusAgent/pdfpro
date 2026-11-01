/** Branded transactional email bodies. Text is the source of truth; HTML is a shell around it. */
import { config } from "./config";

function shell(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF Pro</title></head>
<body style="margin:0;background:#eef2f7;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
    <tr><td style="background:#0c1d33;padding:20px 24px">
      <span style="display:inline-block;background:#dc2626;color:#fff;font-weight:800;border-radius:6px;padding:4px 8px;font-size:14px">PDF</span>
      <span style="color:#fff;font-weight:700;font-size:18px;margin-left:6px">Pro</span>
    </td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
    <tr><td style="padding:16px 24px;background:#f8fafc;color:#64748b;font-size:12px">
      You are receiving this email because an account was requested for ${escapeHtml(config.email.from.replace(/.*<|>.*/g, ""))} at PDF Pro.
      If this was not you, you can safely ignore this message.
    </td></tr>
  </table>
</body></html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">${escapeHtml(label)}</a></p>`;
}

export function verificationEmail(params: { displayName: string | null; url: string }) {
  const name = params.displayName?.trim() || "there";
  const text = [
    `Hi ${name},`,
    "",
    "Confirm your email address to finish setting up your PDF Pro account.",
    "Verified accounts can upload PDFs to private cloud storage and manage subscriptions.",
    "",
    params.url,
    "",
    `This link expires in ${config.auth.verifyTokenHours} hours and can be used once.`,
    "If you did not create a PDF Pro account, ignore this email.",
    "",
    "— The PDF Pro team",
  ].join("\n");
  const html = shell(`
    <p>Hi ${escapeHtml(name)},</p>
    <p>Confirm your email address to finish setting up your PDF Pro account. Verified accounts can upload PDFs to private cloud storage and manage subscriptions.</p>
    ${button(params.url, "Verify my email")}
    <p style="color:#475569;font-size:13px">This link expires in ${config.auth.verifyTokenHours} hours and can be used once.</p>
    <p style="color:#475569;font-size:13px">If you did not create a PDF Pro account, you can ignore this email.</p>
  `);
  return { subject: "Verify your PDF Pro email address", text, html };
}

export function passwordResetEmail(params: { displayName: string | null; url: string }) {
  const name = params.displayName?.trim() || "there";
  const text = [
    `Hi ${name},`,
    "",
    "We received a request to reset the password for your PDF Pro account.",
    "Choose a new password here:",
    "",
    params.url,
    "",
    `This link expires in ${config.auth.resetTokenMinutes} minutes and can be used once.`,
    "Signing in with a new password signs you out of every device.",
    "If you did not request this, no action is needed — your password has not changed.",
    "",
    "— The PDF Pro team",
  ].join("\n");
  const html = shell(`
    <p>Hi ${escapeHtml(name)},</p>
    <p>We received a request to reset the password for your PDF Pro account.</p>
    ${button(params.url, "Choose a new password")}
    <p style="color:#475569;font-size:13px">This link expires in ${config.auth.resetTokenMinutes} minutes and can be used once. Signing in with a new password signs you out of every device.</p>
    <p style="color:#475569;font-size:13px">If you did not request this, no action is needed — your password has not changed.</p>
  `);
  return { subject: "Reset your PDF Pro password", text, html };
}

export function paymentFailedEmail(params: { displayName: string | null; planName: string; graceUntil: Date | null; billingUrl: string }) {
  const name = params.displayName?.trim() || "there";
  const grace = params.graceUntil
    ? `You keep Premium access until ${params.graceUntil.toUTCString()} while we retry the charge.`
    : "Premium access will end at the close of your current billing period.";
  const text = [
    `Hi ${name},`,
    "",
    `We could not confirm the latest payment for your ${params.planName} subscription.`,
    grace,
    "",
    "Update your payment method or try again here:",
    params.billingUrl,
    "",
    "Your files are never deleted — if Premium ends, your account returns to the Free plan (2 GB) and existing files stay safe.",
    "",
    "— The PDF Pro team",
  ].join("\n");
  const html = shell(`
    <p>Hi ${escapeHtml(name)},</p>
    <p>We could not confirm the latest payment for your <strong>${escapeHtml(params.planName)}</strong> subscription.</p>
    <p>${escapeHtml(grace)}</p>
    ${button(params.billingUrl, "Review my billing")}
    <p style="color:#475569;font-size:13px">Your files are never deleted — if Premium ends, your account returns to the Free plan (2 GB) and existing files stay safe.</p>
  `);
  return { subject: "Action needed: PDF Pro payment could not be confirmed", text, html };
}

export function premiumActivatedEmail(params: { displayName: string | null; planName: string; periodEnd: Date | null; dashboardUrl: string }) {
  const name = params.displayName?.trim() || "there";
  const until = params.periodEnd ? ` until ${params.periodEnd.toUTCString()}` : "";
  const text = [
    `Hi ${name},`,
    "",
    `Your ${params.planName} subscription is active${until}.`,
    "You now have 10 GB of private cloud storage, an ad-free experience and a Premium badge.",
    "",
    "Open your dashboard:",
    params.dashboardUrl,
    "",
    "— The PDF Pro team",
  ].join("\n");
  const html = shell(`
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your <strong>${escapeHtml(params.planName)}</strong> subscription is active${escapeHtml(until)}.</p>
    <p>You now have 10 GB of private cloud storage, an ad-free experience and a Premium badge.</p>
    ${button(params.dashboardUrl, "Open my dashboard")}
  `);
  return { subject: "Your PDF Pro Premium subscription is active", text, html };
}

export function notificationEmail(params: { displayName: string | null; title: string; body: string; url: string }) {
  const name = params.displayName?.trim() || "there";
  const text = [`Hi ${name},`, "", params.title, "", params.body, "", params.url, "", "— The PDF Pro team"].join("\n");
  const html = shell(`
    <p>Hi ${escapeHtml(name)},</p>
    <p><strong>${escapeHtml(params.title)}</strong></p>
    <p>${escapeHtml(params.body)}</p>
    ${button(params.url, "Open PDF Pro")}
  `);
  return { subject: params.title, text, html };
}
