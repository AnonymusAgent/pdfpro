import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AppProviders } from "@/components/shell";
import { config } from "@/lib/server/config";
import { buildSessionPayload } from "@/lib/server/session-payload";
import type { SessionPayload } from "@/lib/session-types";

/**
 * Cloudflare site/domain verification: when `CLOUDFLARE_VERIFICATION_TOKEN` is
 * set, the token is emitted as `<meta name="cf-verification" content="…">` so a
 * verification check can read it straight from the HTML. Unset ⇒ no meta tag.
 */
const siteVerificationToken = config.cloudflare.verificationToken;

export const metadata: Metadata = {
  title: { default: "PDF Pro — Editor, Converter & OCR", template: "%s · PDF Pro" },
  description:
    "Edit, annotate, convert, OCR, sign, redact and compress PDFs. Files are processed in your browser by default, with optional private cloud storage.",
  ...(siteVerificationToken
    ? { verification: { other: { "cf-verification": siteVerificationToken } } }
    : {}),
};

export const viewport: Viewport = {
  themeColor: "#0c1d33",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  let session: SessionPayload | null = null;
  try {
    session = await buildSessionPayload();
  } catch {
    // The database may not be reachable during a static build or first boot.
    // Pages that depend on it fail gracefully with their own error states.
    session = null;
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-[#eef2f7] text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <AppProviders session={session}>{children}</AppProviders>
      </body>
    </html>
  );
}
