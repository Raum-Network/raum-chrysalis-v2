import Link from "next/link";

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
  ["Stellar", "Soroban / Testnet / Receipt", "stellar"]
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

const bridgeFeatures = [
  ["QUOTE", "Real-time", "Multi-provider quoting", "Chrysalis V2 compares Circle Gateway, CCTP V2, BridgeKit, and local routes. You see speed, cost, and security tradeoffs before committing a single token."],
  ["ROUTE", "USDC everywhere", "Cross-chain USDC transfers across every supported chain", "Move native USDC between Arc, Base Sepolia, Ethereum Sepolia, Solana Devnet, and Stellar Testnet using the best available Circle rail for the path."],
  ["EXECUTE", "DeFi adapters", "On-arrival action", "Minted or routed USDC can land directly into configured adapters: Uniswap, Morpho, Aave, Marinade through Raydium, or Aquarius."]
];

const nanoFlow = [
  ["01", "x402", "Start any protected flow", "Quote previews stay open. Execution requests, paid route alpha, and protocol scoring can require a small USDC payment before the backend spends compute or relayer time."],
  ["02", "Payment terms", "Receive live Gateway requirements", "The API returns Circle x402 payment requirements with network, token, amount, recipient, timeout, and Gateway verifying contract."],
  ["03", "EIP-712", "Sign GatewayWalletBatched", "Your connected EVM wallet signs a one-use authorization. The app sends it as a Payment-Signature header with the request."],
  ["04", "Settle", "Settle before execution", "Circle Gateway verifies the authorization and settles USDC. Only after payment clears does Chrysalis V2 run the protected route or paid AI resource."],
  ["05", "Receipt", "Response and payment metadata", "The caller receives the result, the provider gets paid, and settlement metadata travels back with the API response for auditability."]
];

function FloatingLetters({ variant = "hero" }: { variant?: "hero" | "section" }) {
  const letters = variant === "hero"
    ? [
      ["C", "18vw", "2%", "2%", undefined, ".12"],
      ["H", "22vw", "5%", undefined, "1%", ".1"],
      ["R", "14vw", undefined, "5%", undefined, ".13"],
      ["Y", "20vw", undefined, undefined, "4%", ".1"],
      ["S", "12vw", "30%", undefined, "-1%", ".12"]
    ]
    : [
      ["C", "21vw", "-8%", undefined, "-4%", ".05"],
      ["H", "14vw", undefined, "-4%", undefined, ".06"]
    ];

  return (
    <div className="arcgrant-letters" aria-hidden="true">
      {letters.map(([letter, fontSize, top, bottom, right, opacity], index) => (
        <span
          key={`${letter}-${index}`}
          className="arcgrant-fl"
          style={{
            fontSize,
            top,
            bottom,
            right,
            left: right ? undefined : index === 3 ? undefined : "2%",
            opacity
          }}
        >
          {letter}
        </span>
      ))}
    </div>
  );
}

export default function Page() {
  const marquee = marqueeItems.concat(marqueeItems);

  return (
    <main className="arcgrant-page">
      <nav className="arcgrant-nav" aria-label="Product navigation">
        <a href="#top" className="arcgrant-logo">ChrysalisV2</a>
        <ul className="arcgrant-nav-links">
          <li><a href="#modes">Modes</a></li>
          <li><a href="#chains">Chains</a></li>
          <li><a href="#protocols">Protocols</a></li>
          <li><a href="#nanopay">Nanopay</a></li>
          <li><Link href="/app" className="arcgrant-nav-cta">Open App -&gt;</Link></li>
        </ul>
      </nav>

      <section className="arcgrant-hero" id="top">
        <FloatingLetters />
        <div className="arcgrant-hero-center">
          <span className="arcgrant-eyebrow">Arc Testnet / Circle Developer Grant</span>
          <h1>ChrysalisV2</h1>
          <p>Cross-chain USDC execution.<br />Nanopayments included in the flow.</p>
          <div className="arcgrant-hero-actions">
            <Link href="/app" className="arcgrant-primary">Open App -&gt;</Link>
            <a href="#modes" className="arcgrant-secondary">Learn more</a>
          </div>
        </div>
      </section>

      <section className="arcgrant-marquee" aria-label="Supported rails">
        <div>
          {marquee.map((item, index) => (
            <span key={`${item}-${index}`}>{item}</span>
          ))}
        </div>
      </section>

      <section className="arcgrant-section" id="modes">
        <FloatingLetters variant="section" />
        <div className="arcgrant-section-inner">
          <span className="arcgrant-label">The Product</span>
          <p className="arcgrant-statement">
            <strong>Two modes. One protocol.</strong><br />
            Transfer USDC across every supported chain, execute into configured protocols on arrival, and charge protected AI or relayer flows per request.
            <span> Native USDC movement, x402 settlement, and protocol execution in one product.</span>
          </p>
          <div className="arcgrant-modes">
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
              <p>Protected routes and paid AI resources use x402. The caller signs a GatewayWalletBatched authorization, the backend verifies settlement, and the response or execution continues only after USDC clears.</p>
              <div>
                {["x402 Protocol", "GatewayWalletBatched", "Payment-Signature", "Execution gating", "AI resources", "Per-call billing"].map((tag) => <small key={tag}>{tag}</small>)}
              </div>
            </article>
          </div>
        </div>
      </section>

      <div className="arcgrant-quote">
        Cross-chain should not be hard.<br />
        <span>We made it boring.</span><br />
        <small>That is the point.</small>
      </div>

      <section className="arcgrant-section" id="chains">
        <div className="arcgrant-section-inner">
          <span className="arcgrant-label">Supported Networks</span>
          <p className="arcgrant-statement">
            USDC transfer is supported across <strong>every configured chain.</strong><br />
            EVM chains carry Gateway x402 nanopayments; Solana and Stellar carry CCTP-backed transfer and protocol execution paths.
          </p>
          <div className="arcgrant-chains">
            {chains.map(([name, sub, kind]) => (
              <article key={name} className={`arcgrant-chain-${kind}`}>
                <h3>{name}</h3>
                <p>{sub}</p>
              </article>
            ))}
          </div>
          <p className="arcgrant-note">Arc, Base, Ethereum, Solana, and Stellar all expose USDC transfer routes. Arc, Base, and Ethereum also support live Circle Gateway x402 signing.</p>
        </div>
      </section>

      <section className="arcgrant-section">
        <div className="arcgrant-section-inner">
          <span className="arcgrant-label">Mode 01 / Bridge + Execute</span>
          <h2 className="arcgrant-big">From <span>source</span><br />to execution.<br />In one move.</h2>
          <div className="arcgrant-features">
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

      <div className="arcgrant-quote">
        They used to think bridges were enough.<br />
        Turns out, <span>execution is the hard part.</span>
      </div>

      <section className="arcgrant-section" id="nanopay">
        <div className="arcgrant-section-inner">
          <span className="arcgrant-label">Mode 02 / Nanopayments</span>
          <h2 className="arcgrant-big">Pay <span>per call.</span><br />Not per month.</h2>
          <p className="arcgrant-statement arcgrant-gap">
            HTTP 402 is now part of the execution path. AI agents, bots, and users can pay for route execution, protocol scoring, data, and compute in USDC, per request, without subscriptions or card rails.
          </p>
          <div className="arcgrant-flow">
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

      <section className="arcgrant-section" id="protocols">
        <div className="arcgrant-section-inner">
          <span className="arcgrant-label">DeFi Adapters / Supported Protocols</span>
          <p className="arcgrant-statement">
            <strong>Only the wired surfaces.</strong> The frontend now shows the transfer rails and protocols Chrysalis V2 actually routes through.
          </p>
          <div className="arcgrant-protocols">
            {protocols.map(([name, type]) => (
              <article key={name}>
                <h3>{name}</h3>
                <p>{type}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <div className="arcgrant-quote">
        Some call it complex.<br />
        We call it <span>infrastructure.</span>
        <small>Build what matters. Chrysalis V2 handles the routing.</small>
      </div>

      <section className="arcgrant-closing" id="contact">
        <FloatingLetters variant="section" />
        <div>
          <h2>That's<br /><span>ChrysalisV2.</span><br />Get on chain.</h2>
          <p>Live on Arc Testnet. Built for cross-chain USDC transfers, Circle Gateway, CCTP V2, and x402 nanopayment-gated execution.</p>
          <Link href="/app" className="arcgrant-secondary">Open the app -&gt;</Link>
        </div>
      </section>

      <footer className="arcgrant-footer">
        <p>Chrysalis V2 2026 / Arc Testnet / Circle Developer Grant</p>
        <ul>
          <li><a href="#modes">Modes</a></li>
          <li><a href="#chains">Chains</a></li>
          <li><a href="#protocols">Protocols</a></li>
          <li><a href="#nanopay">Nanopay</a></li>
        </ul>
      </footer>
    </main>
  );
}
