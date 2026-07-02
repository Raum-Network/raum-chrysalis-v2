import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "App",
  description: "Use Chrysalis V2 to quote, execute, and inspect cross-chain USDC routes and x402 nanopayment-gated flows.",
  openGraph: {
    title: "Chrysalis V2 App",
    description: "Quote, execute, and inspect cross-chain USDC routes and x402 nanopayment-gated flows."
  }
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return children;
}
