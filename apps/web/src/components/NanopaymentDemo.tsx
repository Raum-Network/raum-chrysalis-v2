"use client";

import { useState } from "react";
import { useAccount, useSignTypedData, useSwitchChain } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { CHAIN_KEY_TO_ID } from "../providers";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 + 100;

function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function buildGatewayPaymentAuth(from: `0x${string}`, requirement: PaymentRequirements) {
  const chainId = Number(requirement.network.replace("eip155:", ""));
  if (!Number.isFinite(chainId)) throw new Error(`Unsupported x402 network: ${requirement.network}`);
  const now = Math.floor(Date.now() / 1000);
  const validBefore = now + Math.max(requirement.maxTimeoutSeconds, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS);
  const authorization = {
    from,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter: String(now - 600),
    validBefore: String(validBefore),
    nonce: createNonce()
  };

  return {
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
      ]
    } as const,
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId,
      verifyingContract: requirement.extra.verifyingContract
    } as const,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce
    },
    authorization
  };
}

interface Resource {
  path: string;
  priceUsdc: string;
  description: string;
}

interface PaymentChain {
  key: string;
  name: string;
  vm: "evm" | "svm" | "soroban";
  network: string;
  supportsSignedPayment: boolean;
  note: string;
}

interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: `0x${string}`;
  amount: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  extra: {
    name: "GatewayWalletBatched";
    version: "1";
    verifyingContract: `0x${string}`;
  };
}

interface PaymentRequiredChallenge {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
    mimeType: "application/json";
  };
  accepts: PaymentRequirements[];
}

interface ChallengeResponse {
  scheme: string;
  protocol: string;
  header: string;
  asset: string;
  price: string;
  amount: string;
  payTo: `0x${string}`;
  accepts: PaymentRequirements[];
  paymentRequired: PaymentRequiredChallenge;
  paymentRequiredHeader: string;
  memo: string;
}

const DEMO_RESOURCES: Resource[] = [
  { path: "/paid/protocol-score", priceUsdc: "0.000001", description: "AI-generated protocol trust score" },
  { path: "/paid/route-alpha", priceUsdc: "0.005", description: "AI optimal route recommendation" }
];

const PAYMENT_CHAINS: PaymentChain[] = [
  {
    key: "ARC",
    name: "Arc Testnet",
    vm: "evm",
    network: "eip155:5042002",
    supportsSignedPayment: true,
    note: "Primary Gateway x402 network. Signs GatewayWalletBatched EIP-712 authorizations."
  },
  {
    key: "BASE_SEPOLIA",
    name: "Base Sepolia",
    vm: "evm",
    network: "eip155:84532",
    supportsSignedPayment: true,
    note: "Gateway-compatible EVM rail. Pays from the connected wallet's Gateway balance on Base Sepolia."
  },
  {
    key: "ETHEREUM_SEPOLIA",
    name: "Ethereum Sepolia",
    vm: "evm",
    network: "eip155:11155111",
    supportsSignedPayment: true,
    note: "Gateway-compatible EVM rail. Pays from the connected wallet's Gateway balance on Ethereum Sepolia."
  },
  {
    key: "SOLANA_DEVNET",
    name: "Solana Devnet",
    vm: "svm",
    network: "solana-devnet",
    supportsSignedPayment: false,
    note: "Included for CCTP/protocol receipt context. Circle Gateway x402 signing is EVM-only here."
  },
  {
    key: "STELLAR_TESTNET",
    name: "Stellar Testnet",
    vm: "soroban",
    network: "stellar-testnet",
    supportsSignedPayment: false,
    note: "Included for Soroban protocol receipts. Circle Gateway x402 signing is not enabled here yet."
  }
];

function encodeBase64Json(payment: Record<string, unknown>) {
  const json = JSON.stringify(payment);
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    return window.btoa(json);
  }
  return btoa(json);
}

function decodeBase64Json<T>(value: string): T {
  return JSON.parse(atob(value)) as T;
}

export default function NanopaymentDemo() {
  const { address, isConnected } = useAccount();
  const { chain } = useAccount();
  const { switchChain } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  const [selectedResource, setSelectedResource] = useState<Resource>(DEMO_RESOURCES[0]);
  const [selectedChain, setSelectedChain] = useState<PaymentChain>(PAYMENT_CHAINS[0]);
  const [status, setStatus] = useState<"idle" | "signing" | "fetching" | "success" | "denied">("idle");
  const [result, setResult] = useState<any>(null);
  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchPaidResource(paymentHeader: string) {
    const res = await fetch(`${API_URL}${selectedResource.path}`, {
      headers: { "Payment-Signature": paymentHeader }
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.reason ?? data?.message ?? data?.error ?? `Paid request failed with HTTP ${res.status}`);
    }
    const settlementHeader = res.headers.get("PAYMENT-RESPONSE");
    const settlement = settlementHeader ? decodeBase64Json<Record<string, unknown>>(settlementHeader) : null;
    setResult({ ...data, settlement });
    setChallenge(null);
    setStatus("success");
  }

  async function fetchChallenge(): Promise<ChallengeResponse | null> {
    setStatus("fetching");
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/paid/challenge?path=${encodeURIComponent(selectedResource.path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Challenge request failed with HTTP ${res.status}`);
      setChallenge(data);
      setStatus("denied");
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
      return null;
    }
  }

  async function payAndFetch() {
    if (!address) return;
    if (!selectedChain.supportsSignedPayment) {
      setError(`${selectedChain.name} is visible in the app, but Circle Gateway x402 signing is currently enabled only on EVM Gateway rails.`);
      return;
    }
    const chainId = CHAIN_KEY_TO_ID[selectedChain.key];
    if (chainId && chain?.id !== chainId) {
      switchChain({ chainId });
      setError(`Switch your wallet to ${selectedChain.name}, then click Sign & Pay again.`);
      return;
    }

    setStatus("signing");
    setError(null);

    try {
      const liveChallenge = challenge?.paymentRequired ? challenge : await fetchChallenge();
      const requirement = liveChallenge?.paymentRequired.accepts.find((item) => item.network === selectedChain.network);
      if (!liveChallenge || !requirement) {
        throw new Error(`The API did not publish a Gateway x402 payment option for ${selectedChain.name}.`);
      }

      const typedData = buildGatewayPaymentAuth(address, requirement);
      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message
      });

      const paymentHeader = encodeBase64Json({
        x402Version: liveChallenge.paymentRequired.x402Version,
        resource: liveChallenge.paymentRequired.resource,
        accepted: requirement,
        payload: {
          authorization: typedData.authorization,
          signature
        }
      });

      setStatus("fetching");
      await fetchPaidResource(paymentHeader);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }

  return (
    <div className="nano-card">
      <div className="nano-header">
        <div>
          <div className="nano-eyebrow">Circle x402</div>
          <h3 className="nano-title">Nanopayments</h3>
          <p className="nano-sub">Live pay-per-call AI endpoints · USDC Gateway settlement · all current ArcGrant chains visible</p>
        </div>
        {!isConnected && (
          <div className="nano-connect">
            <ConnectButton accountStatus="avatar" chainStatus="none" showBalance={false} />
          </div>
        )}
      </div>

      <div className="nano-chain-picker" aria-label="Nanopayment chain selector">
        {PAYMENT_CHAINS.map((chain) => (
          <button
            key={chain.key}
            type="button"
            className={`nano-chain${selectedChain.key === chain.key ? " active" : ""}${chain.supportsSignedPayment ? "" : " disabled"}`}
            onClick={() => {
              setSelectedChain(chain);
              setStatus("idle");
              setResult(null);
              setChallenge(null);
              setError(null);
            }}
          >
            <span>{chain.name}</span>
            <small>{chain.vm.toUpperCase()} · {chain.supportsSignedPayment ? "signable" : "view only"}</small>
          </button>
        ))}
      </div>

      <p className="nano-chain-note">{selectedChain.note}</p>

      {/* Resource selector */}
      <div className="nano-resources">
        {DEMO_RESOURCES.map((r) => (
          <button
            key={r.path}
            className={`nano-resource${selectedResource.path === r.path ? " active" : ""}`}
            onClick={() => { setSelectedResource(r); setStatus("idle"); setResult(null); setChallenge(null); }}>
            <span className="nano-resource-name">{r.description}</span>
            <span className="nano-resource-price">{r.priceUsdc} USDC</span>
            <span className="nano-resource-path">{r.path}</span>
          </button>
        ))}
      </div>

      {/* Flow description */}
      <div className="nano-flow-steps">
        <div className="nano-flow-step">
          <div className="nano-flow-num">1</div>
          <div>Load live x402 payment requirements from the API</div>
        </div>
        <div className="nano-flow-step">
          <div className="nano-flow-num">2</div>
          <div>Sign <code>GatewayWalletBatched</code> authorization on {selectedChain.name} ({selectedResource.priceUsdc} USDC)</div>
        </div>
        <div className="nano-flow-step">
          <div className="nano-flow-num">3</div>
          <div>Send <code>Payment-Signature</code> → settle through Circle Gateway → receive response</div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="nano-actions">
        <button className="nano-btn-try" onClick={fetchChallenge} disabled={status === "fetching"}>
          {status === "fetching" && !challenge ? "Loading…" : "1. Load Payment Terms"}
        </button>
        <button
          className="nano-btn-pay"
          onClick={payAndFetch}
          disabled={!isConnected || !selectedChain.supportsSignedPayment || status === "signing" || status === "fetching"}>
          {status === "signing" ? "Waiting for signature…" : status === "fetching" && challenge ? "Settling…" : "2. Sign & Pay"}
        </button>
      </div>

      {!isConnected && (
        <p className="nano-wallet-hint">Connect your wallet to sign the Gateway x402 payment authorization.</p>
      )}
      {isConnected && !selectedChain.supportsSignedPayment && (
        <p className="nano-wallet-hint">{selectedChain.name} is included for full-chain coverage; payment signing is currently EVM-only.</p>
      )}

      {/* Live challenge */}
      {challenge && status === "denied" && (
        <div className="nano-result nano-result--denied">
          <div className="nano-result-head">
            <span className="nano-status-badge nano-badge--402">x402</span>
            <span>Payment terms ready</span>
          </div>
          <div className="nano-result-row"><span>Scheme</span><strong>{challenge.scheme}</strong></div>
          <div className="nano-result-row"><span>Header</span><strong>{challenge.header}</strong></div>
          <div className="nano-result-row"><span>Price</span><strong>{challenge.price} USDC</strong></div>
          <div className="nano-result-row"><span>Pay to</span><strong className="nano-mono">{challenge.payTo.slice(0, 10)}…</strong></div>
          <div className="nano-result-row"><span>Networks</span><strong>{challenge.accepts.map((item) => item.network).join(", ")}</strong></div>
          <div className="nano-result-memo">{challenge.memo}</div>
        </div>
      )}

      {/* Success result */}
      {result && status === "success" && (
        <div className="nano-result nano-result--success">
          <div className="nano-result-head">
            <span className="nano-status-badge nano-badge--200">HTTP 200</span>
            <span>Paid &amp; received</span>
          </div>
          {result.score !== undefined && (
            <div className="nano-score-hero">
              <div className="nano-score-num">{result.score}</div>
              <div className="nano-score-label">Trust score /100</div>
            </div>
          )}
          {result.recommendation !== undefined && (
            <div className="nano-score-hero">
              <div className="nano-score-route">{result.recommendation}</div>
              <div className="nano-score-label">Recommended route</div>
            </div>
          )}
          {result.explanation && <p className="nano-explanation">{result.explanation}</p>}
          {result.reason && <p className="nano-explanation">{result.reason}</p>}
          {result.paidWith && <p className="nano-paid-with">✓ {result.paidWith}</p>}
          {result.settlement?.transaction && <p className="nano-paid-with">Settlement: {String(result.settlement.transaction)}</p>}
        </div>
      )}

      {error && <p className="hint" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}
