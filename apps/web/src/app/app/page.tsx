"use client";

import FlowBuilder from "../../components/FlowBuilder";
import AppWalletConnect from "../../components/AppWalletConnect";
import Link from "next/link";

export default function AppPage() {
  return (
    <main className="shell app-shell">
      <Link href="/" className="app-back-home" aria-label="Back to home" title="Back to home">
        <span aria-hidden="true" />
      </Link>
      <div className="app-wallet-topbar">
        <AppWalletConnect />
      </div>
      <section className="hero">
        <h1>Chrysalis V2</h1>
      </section>

      <FlowBuilder />
    </main>
  );
}
