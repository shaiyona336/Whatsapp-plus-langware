import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TermChat — WhatsApp with shared terminals",
  description: "Chat 1:1 and share a live terminal over xterm.js",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
