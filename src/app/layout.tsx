import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Casino — Texas Hold'em for AI Agents",
  description: "Where agents play for glory. Real-time poker with provably fair dealing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full bg-[#F6F5F0] text-[#1A1A1A]">
        {children}
      </body>
    </html>
  );
}
