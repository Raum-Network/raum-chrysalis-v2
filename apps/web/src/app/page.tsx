"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { faqItems, faqJsonLd, organizationJsonLd, softwareJsonLd, websiteJsonLd } from "../lib/seo";

const marqueeItems = [
  "CCTP V2",
  "Circle Gateway",
  "x402 Protocol",
  "GatewayWalletBatched",
  "Payment-Signature",
  "Nanopayments",
  "USDC Cross-Chain",
  "Arc Testnet",
  "Base Sepolia",
  "Ethereum Sepolia",
  "Solana Devnet",
  "Stellar Testnet",
  "Marinade",
  "Raydium CPMM",
  "Aquarius",
  "Aave",
  "Morpho",
  "Uniswap"
];

const chains = [
  ["Arc", "EVM / Testnet / Primary", "evm"],
  ["Base", "EVM / Sepolia / x402", "evm"],
  ["Ethereum", "EVM / Sepolia / x402", "evm"],
  ["Solana", "Non-EVM / Devnet / Receipt", "sol"],
  ["Stellar", "Non-EVM / Testnet / Receipt", "stellar"]
];

const protocols = [
  ["USDC Transfer", "Cross-chain / All supported chains"],
  ["Gateway x402", "Nanopayments / Arc, Base, Ethereum"],
  ["Circle Gateway", "Unified balance / EVM"],
  ["CCTP V2", "Native USDC burn + mint"],
  ["Marinade + Raydium", "USDC -> wSOL -> SOL -> mSOL / Solana"],
  ["Aquarius", "AMM / Stellar"],
  ["Uniswap V3", "USDC -> WETH / EVM"],
  ["Morpho Blue", "Lending / Base"],
  ["Aave V3", "Lending / Ethereum"]
];

const getMarqueeIcon = (item: string): string | null => {
  switch (item) {
    case "CCTP V2":
    case "Circle Gateway":
    case "USDC Cross-Chain":
      return "/icons/circle.svg";
    case "Arc Testnet":
      return "/icons/arc.svg";
    case "x402 Protocol":
      return "/icons/x402.svg";
    case "GatewayWalletBatched":
    case "Payment-Signature":
    case "Nanopayments":
      return "/icons/circle.svg";
    case "Base Sepolia":
      return "/icons/base.png";
    case "Ethereum Sepolia":
      return "/icons/eth.svg";
    case "Solana Devnet":
      return "/icons/sol.svg";
    case "Stellar Testnet":
      return "/icons/stellar.svg";
    case "Marinade":
      return "/icons/marinade.png";
    case "Raydium CPMM":
      return "/icons/raydium.png";
    case "Aquarius":
      return "/icons/aquarius.png";
    case "Aave":
      return "/icons/aave.svg";
    case "Morpho":
      return "/icons/morpho.png";
    case "Uniswap":
      return "/icons/uniswap.svg";
    default:
      return null;
  }
};

const getChainIcon = (name: string): string | null => {
  switch (name) {
    case "Arc":
      return "/icons/arc.svg";
    case "Base":
      return "/icons/base.png";
    case "Ethereum":
      return "/icons/eth.svg";
    case "Solana":
      return "/icons/sol.svg";
    case "Stellar":
      return "/icons/stellar.svg";
    default:
      return null;
  }
};

const getProtocolIcons = (name: string): string[] => {
  switch (name) {
    case "USDC Transfer":
    case "Circle Gateway":
    case "CCTP V2":
      return ["/icons/circle.svg"];
    case "Gateway x402":
      return ["/icons/x402.svg"];
    case "Marinade + Raydium":
      return ["/icons/marinade.png", "/icons/raydium.png"];
    case "Aquarius":
      return ["/icons/aquarius.png"];
    case "Uniswap V3":
      return ["/icons/uniswap.svg"];
    case "Morpho Blue":
      return ["/icons/morpho.png"];
    case "Aave V3":
      return ["/icons/aave.svg"];
    default:
      return [];
  }
};

const bridgeFeatures = [
  ["QUOTE", "Real-time", "Multi-provider quoting", "Chrysalis V2 compares Circle Gateway, CCTP V2, BridgeKit, and local routes. You see speed, cost, and security tradeoffs before committing a single token."],
  ["ROUTE", "USDC everywhere", "Cross-chain USDC transfers across every supported chain", "Move native USDC between Arc, Base Sepolia, Ethereum Sepolia, Solana Devnet, and Stellar Testnet using the best available Circle rail for the path."],
  ["EXECUTE", "DeFi adapters", "On-arrival action", "Minted or routed USDC can land directly into configured adapters: Uniswap, Morpho, Aave, Marinade through Raydium, or Aquarius."]
];

const nanoFlow = [
  ["01", "x402", "Start any protected flow", "Quote previews stay open. Execution requests, paid route alpha, and protocol scoring can require a small USDC payment before premium routing starts."],
  ["02", "Payment terms", "Receive live Gateway requirements", "Chrysalis shows Circle x402 payment requirements with network, token, amount, recipient, timeout, and Gateway verifying contract."],
  ["03", "EIP-712", "Sign GatewayWalletBatched", "Your connected EVM wallet signs a one-use authorization. The app sends it as a Payment-Signature header with the request."],
  ["04", "Settle", "Settle before execution", "Circle Gateway verifies the authorization and settles USDC. Only after payment clears does Chrysalis V2 run the protected route or paid AI resource."],
  ["05", "Receipt", "Response and payment metadata", "The caller receives the result, the provider gets paid, and settlement metadata travels back for auditability."]
];

function ChainHeroArt() {
  return (
    <div className="chain-hero-art" aria-label="Cross-chain blockchain execution visual">
      <div className="chain-window route-window">
        <div className="retro-title"><i /><i /><i /><strong>route.plan</strong></div>
        <div className="chain-path">
          <span>Arc</span>
          <b />
          <span>Base</span>
          <b />
          <span>Solana</span>
          <b />
          <span>Stellar</span>
        </div>
        <div className="node-field">
          {Array.from({ length: 12 }).map((_, index) => <span key={index} />)}
        </div>
      </div>
      <div className="chain-window block-window">
        <div className="retro-title"><i /><i /><i /><strong>blocks</strong></div>
        <div className="block-stack">
          <span>USDC</span>
          <span>CCTP</span>
          <span>x402</span>
        </div>
      </div>
      <div className="chain-window tx-window">
        <div className="retro-title"><i /><i /><i /><strong>tx</strong></div>
        <p>0x7a...c19f</p>
        <small>confirmed</small>
      </div>
      <div className="coin-orbit">
        <span>USDC</span>
        <span>x402</span>
        <span>NFT</span>
      </div>
    </div>
  );
}

export default function Page() {
  const marquee = marqueeItems.concat(marqueeItems);
  const [theme, setTheme] = useState("light");
  const structuredData = [organizationJsonLd, websiteJsonLd, softwareJsonLd, faqJsonLd];

  // Load theme preference on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem("chrysalis_theme");
    if (savedTheme === "dark") {
      setTheme("dark");
    }
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem("chrysalis_theme", next);
      return next;
    });
  };

  return (
    <main className={`retro-site${theme === "dark" ? " dark" : ""}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c")
        }}
      />

      {/* Ambient Metamorphosis Background */}
      <div className="ambient-metamorphosis-container" aria-hidden="true">
        {/* Ambient Random Translucent Butterflies flying across the whole website */}
        <div className="ambient-butterfly ab-1">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-2">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-3">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-4">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-5">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-6">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-7">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-8">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-9">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-10">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-11">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-12">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-13">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-14">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-15">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-16">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-17">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-18">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-19">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-20">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-21">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-22">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-23">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-24">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
      </div>

      <nav className="retro-nav" aria-label="Product navigation">
        <a href="#top" className="retro-logo" aria-label="Chrysalis Home">
          <img src="/raumv2logo.png" className="nav-logo-img" alt="Chrysalis logo" />
        </a>
        <div>
          <a href="#modes">Modes</a>
          <a href="#chains">Chains</a>
          <a href="#protocols">Protocols</a>
          <a href="#answers">Answers</a>
          <a href="#nanopay">Nanopay</a>
          <button
            type="button"
            onClick={toggleTheme}
            style={{
              background: theme === "dark" ? "#222235" : "#fff",
              color: theme === "dark" ? "#ffd24a" : "#16151c",
              border: "2px solid var(--r-line, #16151c)",
              padding: "8px 12px",
              fontSize: "12px",
              fontWeight: "bold",
              cursor: "pointer",
              boxShadow: theme === "dark" ? "2px 2px 0 rgba(0,0,0,.4)" : "3px 3px 0 var(--r-line, #16151c)",
              marginRight: "4px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: "36px",
              minWidth: "36px",
              fontFamily: "var(--os-font-mono, monospace)",
              transition: "all 0.1s ease"
            }}
            title="Toggle Theme"
          >
            {theme === "dark" ? "🌙" : "☀️"}
          </button>
          <Link href="/app" className="nav-cta">Open App</Link>
        </div>
      </nav>

      <section className="retro-hero retro-product-hero" id="top">
        <div className="retro-hero-copy">
          <p></p>
          <div className="hero-butterfly-brand">
            <img src="/raumv2logo.png" alt="Chrysalis butterfly" className="hero-butterfly-img" />
            <h1>Chrysalis<span>V2</span></h1>
          </div>
          <span>Cross-chain USDC execution. Nanopayments included in the flow.</span>
          <div className="retro-actions">
            <Link href="/app" className="retro-btn primary">Open App</Link>
            <a href="#modes" className="retro-btn">Learn More</a>
          </div>
        </div>
        <ChainHeroArt />
      </section>

      <section className="retro-marquee" aria-label="Supported rails">
        <div>
          {marquee.map((item, index) => {
            const icon = getMarqueeIcon(item);
            return (
              <span key={`${item}-${index}`}>
                {icon && <img src={icon} alt="" className="marquee-icon" />}
                {item}
              </span>
            );
          })}
        </div>
      </section>

      <section className="retro-section" id="modes">
        <div className="retro-section-inner">
          <p className="retro-kicker">The Product</p>
          <p className="retro-statement">
            <strong>Two modes. One protocol.</strong><br />
            Transfer USDC across every supported chain, execute into configured protocols on arrival, and charge protected AI or relayer flows per request.
            <span> Native USDC movement, x402 settlement, and protocol execution in one product.</span>
          </p>
          <div className="retro-modes">
            <article>
              <span>Mode 01</span>
              <h2>Bridge + Execute</h2>
              <p>Choose source chain, destination, amount, protocol, and action. Chrysalis V2 quotes Circle Gateway, CCTP V2, BridgeKit, or local execution, then routes USDC into the configured adapter on arrival.</p>
              <div>
                {["USDC on every chain", "Circle CCTP V2", "Circle Gateway", "BridgeKit", "DeFi adapters", "Auto-routing"].map((tag) => <small key={tag}>{tag}</small>)}
              </div>
            </article>
            <article>
              <span>Mode 02</span>
              <h2>Nanopayments</h2>
              <p>Protected routes and paid AI resources use x402. The caller signs a GatewayWalletBatched authorization, payment settlement is verified, and the response or execution continues only after USDC clears.</p>
              <div>
                {["x402 Protocol", "GatewayWalletBatched", "Payment-Signature", "Execution gating", "AI resources", "Per-call billing"].map((tag) => <small key={tag}>{tag}</small>)}
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="retro-section" id="answers">
        <div className="retro-section-inner">
          <p className="retro-kicker">Search Answers</p>
          <p className="retro-statement">
            <strong>Quick answers for users and search engines.</strong><br />
            Chrysalis V2 is a Raum Network app for cross-chain USDC transfer, Circle Gateway routing, CCTP V2 settlement, x402 nanopayments, and protocol execution.
          </p>
          <div className="retro-faq">
            {faqItems.map((item) => (
              <article key={item.question}>
                <h2>{item.question}</h2>
                <p>{item.answer}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <div className="retro-quote">
        Cross-chain should not be hard.<br />
        <span>We made it boring.</span><br />
        <small>That is the point.</small>
      </div>

      <section className="retro-section" id="chains">
        <div className="retro-section-inner">
          <p className="retro-kicker">Supported Networks</p>
          <p className="retro-statement">
            USDC transfer is supported across <strong>every configured chain.</strong><br />
            EVM chains carry Gateway x402 nanopayments; Solana and Stellar carry CCTP-backed transfer and protocol execution paths.
          </p>
          <div className="retro-chains">
            {chains.map(([name, sub, kind]) => {
              const icon = getChainIcon(name);
              return (
                <article key={name} className={`chain-${kind}`}>
                  <div className="chain-title-wrap">
                    {icon && <img src={icon} alt="" className="chain-logo" />}
                    <h3>{name}</h3>
                  </div>
                  <p>{sub}</p>
                </article>
              );
            })}
          </div>
          <p className="retro-note">Arc, Base, Ethereum, Solana, and Stellar all expose USDC transfer routes. Arc, Base, and Ethereum also support live Circle Gateway x402 signing.</p>
        </div>
      </section>

      <section className="retro-section">
        <div className="retro-section-inner">
          <p className="retro-kicker">Mode 01 / Bridge + Execute</p>
          <h2 className="retro-big">From <span>source</span><br />to execution.<br />In one move.</h2>
          <div className="retro-features">
            {bridgeFeatures.map(([label, badge, title, copy]) => (
              <article key={label}>
                <h3>{label}</h3>
                <div>
                  <small>{badge}</small>
                  <h4>{title}</h4>
                  <p>{copy}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <div className="retro-quote">
        They used to think bridges were enough.<br />
        Turns out, <span>execution is the hard part.</span>
      </div>

      <section className="retro-section" id="nanopay">
        <div className="retro-section-inner">
          <p className="retro-kicker">Mode 02 / Nanopayments</p>
          <h2 className="retro-big">Pay <span>per call.</span><br />Not per month.</h2>
          <p className="retro-statement retro-gap">
            HTTP 402 is now part of the execution path. AI agents, bots, and users can pay for route execution, protocol scoring, data, and compute in USDC, per request, without subscriptions or card rails.
          </p>
          <div className="retro-flow">
            {nanoFlow.map(([idx, badge, title, copy]) => (
              <article key={idx}>
                <strong>{idx}</strong>
                <div>
                  <small>{badge}</small>
                  <h4>{title}</h4>
                  <p>{copy}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="retro-section" id="protocols">
        <div className="retro-section-inner">
          <p className="retro-kicker">DeFi Adapters / Supported Protocols</p>
          <p className="retro-statement">
            <strong>Only the wired surfaces.</strong> The frontend now shows the transfer rails and protocols Chrysalis V2 actually routes through.
          </p>
          <div className="retro-protocols">
            {protocols.map(([name, type]) => {
              const icons = getProtocolIcons(name);
              return (
                <article key={name}>
                  <div className="protocol-title-wrap">
                    <div className="protocol-logos">
                      {icons.map((icon, idx) => (
                        <img key={idx} src={icon} alt="" className="protocol-logo" />
                      ))}
                    </div>
                    <h3>{name}</h3>
                  </div>
                  <p>{type}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <div className="retro-quote">
        Some call it complex.<br />
        We call it <span>infrastructure.</span>
        <small>Build what matters. Chrysalis V2 handles the routing.</small>
      </div>

      <section className="retro-closing" id="contact">
        <div>
          <h2>That's<br /><span>ChrysalisV2.</span><br />Get on chain.</h2>
          <p>Live on Arc Testnet. Built for cross-chain USDC transfers, Circle Gateway, CCTP V2, and x402 nanopayment-gated execution.</p>
          <Link href="/app" className="retro-btn">Open the App</Link>
        </div>
      </section>

      <footer className="retro-footer">
        <p>© 2021 - 2026 <a href="https://raum.network" target="_blank" rel="noopener noreferrer">Raum Network</a>. Revolutionizing DeFi. All rights reserved. </p>
        <ul>
          <li><a href="https://github.com/raum-network" target="_blank" rel="noopener noreferrer">Github</a></li>
          <li><a href="https://raum.network" target="_blank" rel="noopener noreferrer">RN Website</a></li>
        </ul>
      </footer>
    </main>
  );
}
