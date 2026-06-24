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
        <span>402</span>
        <span>NFT</span>
      </div>
    </div>
  );
}

export default function Page() {
  const marquee = marqueeItems.concat(marqueeItems);

  return (
    <main className="retro-site">
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
          <a href="#nanopay">Nanopay</a>
          <Link href="/app" className="nav-cta">Open App</Link>
        </div>
      </nav>

      <section className="retro-hero retro-product-hero" id="top">
        <div className="retro-hero-copy">
          <p>Arc Testnet / Circle Developer Grant</p>
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
          {marquee.map((item, index) => (
            <span key={`${item}-${index}`}>{item}</span>
          ))}
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
            {chains.map(([name, sub, kind]) => (
              <article key={name} className={`chain-${kind}`}>
                <h3>{name}</h3>
                <p>{sub}</p>
              </article>
            ))}
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
            {protocols.map(([name, type]) => (
              <article key={name}>
                <h3>{name}</h3>
                <p>{type}</p>
              </article>
            ))}
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
