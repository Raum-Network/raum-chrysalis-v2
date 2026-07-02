import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "../providers";
import { absoluteUrl, siteDescription, siteKeywords, siteName, siteTitle, siteUrl } from "../lib/seo";
import "./styles.css";

const verificationOther: Record<string, string> = {};

if (process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION) {
  verificationOther["msvalidate.01"] = process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION;
}

if (process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION) {
  verificationOther["google-site-verification"] = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION;
}

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: `%s | ${siteName}`
  },
  description: siteDescription,
  applicationName: siteName,
  authors: [{ name: "Raum Network", url: "https://raum.network" }],
  creator: "Raum Network",
  publisher: "Raum Network",
  category: "finance",
  keywords: siteKeywords,
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icon.png", type: "image/png" }
    ],
    apple: [{ url: "/icon.png", type: "image/png" }]
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName,
    title: siteTitle,
    description: siteDescription,
    images: [
      {
        url: absoluteUrl("/raumv2logo.png"),
        width: 1200,
        height: 630,
        alt: "Chrysalis V2 cross-chain USDC execution"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: [absoluteUrl("/raumv2logo.png")]
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1
    }
  },
  verification: {
    other: verificationOther
  }
};

export const viewport: Viewport = {
  themeColor: "#f6d85b",
  colorScheme: "light dark"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
