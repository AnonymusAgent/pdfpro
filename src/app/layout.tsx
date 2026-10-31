import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AppProviders } from "@/components/shell";

export const metadata: Metadata = {
  title: { default: "PDF Pro — Editor, Converter & OCR", template: "%s · PDF Pro" },
  description:
    "Edit, annotate, convert, OCR, sign, redact and compress PDFs. Files are processed in your browser by default.",
};

export const viewport: Viewport = {
  themeColor: "#0c1d33",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-[#eef2f7] text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
