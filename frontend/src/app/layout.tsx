import type { Metadata } from "next";
import { Outfit, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Providers } from "./providers";
import "./globals.css";

// Outfit chosen as the closest free metric match to the outgoing reference product's
// webfont — see .claude/specs/S-fidelity-ui.md §2.9 for the measured glyph-advance
// comparison. adjustFontFallback (on by default) emits a metric-adjusted Arial
// fallback @font-face automatically.
const fontSans = Outfit({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VyomFlow",
  description: "An agent workspace that runs tools, streams work, and keeps the ledger.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  openGraph: {
    title: "VyomFlow",
    description: "An agent workspace that runs tools, streams work, and keeps the ledger.",
    images: ["/og-image.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "VyomFlow",
    images: ["/og-image.png"],
  },
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* ClerkProvider inside <body>, not wrapping <html> — required for
          Next.js 16 cache-components compatibility (Clerk docs). */}
      <body className="min-h-full flex flex-col">
        <ClerkProvider>
          <Providers>{children}</Providers>
        </ClerkProvider>
      </body>
    </html>
  );
}
