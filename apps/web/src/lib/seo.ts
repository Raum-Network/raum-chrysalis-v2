export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://raum.network").replace(/\/$/, "");

export const siteName = "Chrysalis V2";

export const siteTitle = "Chrysalis V2 | Cross-chain USDC execution and x402 nanopayments";

export const siteDescription =
  "Chrysalis V2 routes USDC across Arc, Base, Ethereum, Solana, and Stellar, then executes into DeFi adapters with Circle Gateway, CCTP V2, BridgeKit, and x402 nanopayments.";

export const siteKeywords = [
  "Chrysalis V2",
  "Raum Network",
  "cross-chain USDC",
  "Circle Gateway",
  "CCTP V2",
  "x402",
  "nanopayments",
  "Arc Testnet",
  "Base Sepolia",
  "Ethereum Sepolia",
  "Solana Devnet",
  "Stellar Testnet",
  "DeFi routing",
  "protocol execution",
  "USDC bridge"
];

export const seoRoutes = [
  {
    path: "/",
    title: siteTitle,
    description: siteDescription,
    priority: 1,
    changeFrequency: "weekly" as const
  },
  {
    path: "/app",
    title: "Chrysalis V2 App | Cross-chain USDC dashboard",
    description: "Dashboard for cross-chain USDC balances, routes, transactions, receipts, and x402 nanopayment flows.",
    priority: 0.9,
    changeFrequency: "weekly" as const
  },
  {
    path: "/app/execute",
    title: "Execute cross-chain USDC routes | Chrysalis V2",
    description: "Build USDC bridge and execute routes across Arc, Base, Ethereum, Solana, and Stellar with protocol adapters.",
    priority: 0.85,
    changeFrequency: "weekly" as const
  },
  {
    path: "/app/transactions",
    title: "Cross-chain transaction history | Chrysalis V2",
    description: "Track Chrysalis V2 route history, live chain checks, and settlement state for USDC execution.",
    priority: 0.7,
    changeFrequency: "weekly" as const
  },
  {
    path: "/app/receipts",
    title: "Arc receipt NFTs | Chrysalis V2",
    description: "View Arc receipt NFTs and audit metadata for cross-chain USDC route execution.",
    priority: 0.65,
    changeFrequency: "weekly" as const
  },
  {
    path: "/app/terminal",
    title: "Operator terminal | Chrysalis V2",
    description: "Query and inspect Chrysalis V2 routes, receipts, and protocol execution from an operator terminal.",
    priority: 0.6,
    changeFrequency: "weekly" as const
  }
];

export const absoluteUrl = (path = "/") => `${siteUrl}${path.startsWith("/") ? path : `/${path}`}`;

export const faqItems = [
  {
    question: "What is Chrysalis V2?",
    answer:
      "Chrysalis V2 is a cross-chain USDC execution app from Raum Network. It routes USDC across supported EVM and non-EVM chains, then executes configured DeFi actions on arrival."
  },
  {
    question: "Which chains does Chrysalis V2 support?",
    answer:
      "Chrysalis V2 supports Arc Testnet, Base Sepolia, Ethereum Sepolia, Solana Devnet, and Stellar Testnet for USDC transfer and protocol execution paths."
  },
  {
    question: "How does Chrysalis V2 use Circle Gateway, CCTP V2, and x402?",
    answer:
      "Chrysalis V2 compares Circle Gateway, CCTP V2, BridgeKit, and local routes for USDC movement. x402 gates paid routes, AI resources, and relayer flows with per-request USDC settlement."
  },
  {
    question: "What can users do with Chrysalis V2?",
    answer:
      "Users can quote cross-chain USDC routes, bridge funds, execute into protocols such as Uniswap, Morpho, Aave, Marinade, Raydium, and Aquarius, and review receipts and transaction history."
  }
];

export const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Raum Network",
  url: "https://raum.network",
  logo: absoluteUrl("/raumv2logo.png"),
  sameAs: ["https://github.com/raum-network"]
};

export const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: siteName,
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  url: absoluteUrl("/"),
  image: absoluteUrl("/raumv2logo.png"),
  description: siteDescription,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD"
  },
  featureList: [
    "Cross-chain USDC transfer",
    "Circle Gateway routing",
    "CCTP V2 routing",
    "x402 nanopayment-gated execution",
    "DeFi adapter execution",
    "Arc receipt NFTs"
  ],
  creator: {
    "@type": "Organization",
    name: "Raum Network",
    url: "https://raum.network"
  }
};

export const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: siteName,
  url: absoluteUrl("/"),
  description: siteDescription,
  publisher: {
    "@type": "Organization",
    name: "Raum Network"
  }
};

export const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqItems.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer
    }
  }))
};
