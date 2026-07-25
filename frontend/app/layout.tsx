import type { Metadata } from "next";
import { Space_Grotesk, Source_Serif_4, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { SkipNav } from "../components/SkipNav";
import { DisclaimerBanner } from "../components/DisclaimerBanner";
import { KeyboardHelp } from "../components/KeyboardHelp";

const grotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", variable: "--font-grotesk" });
const source = Source_Serif_4({ subsets: ["latin"], display: "swap", variable: "--font-source" });
const plex = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap", variable: "--font-plex" });

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://evidencelens.pages.dev";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "EvidenceLens", template: "%s · EvidenceLens" },
  description: "Free, public, agentic biomedical evidence search with conflict-of-interest badges.",
  applicationName: "EvidenceLens",
  authors: [{ name: "EvidenceLens contributors" }],
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "EvidenceLens",
    url: SITE,
    title: "EvidenceLens",
    description: "Free, public, agentic biomedical evidence search.",
  },
  twitter: { card: "summary_large_image", title: "EvidenceLens" },
};

const ORG_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "EvidenceLens",
  url: SITE,
  logo: `${SITE}/icon.png`,
  description:
    "Free, public, agentic biomedical evidence search engine. Hybrid (BM25 + vector + citation + recency) ranker, COI badges from CMS Open Payments, three free inference tiers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${source.variable} ${plex.variable}`}>
      <head>
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG_JSONLD) }}
        />
      </head>
      <body>
        <SkipNav />
        <DisclaimerBanner />
        <main id="main">{children}</main>
        <KeyboardHelp />
      </body>
    </html>
  );
}
