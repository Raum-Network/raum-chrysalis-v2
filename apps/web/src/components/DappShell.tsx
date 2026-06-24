"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, createPublicClient, http } from "viem";
import { useAccount, useReadContract } from "wagmi";
import type { AppConfig, TransactionResponse, TransactionsResponse } from "@arc-os/sdk";
import AppWalletConnect from "./AppWalletConnect";
import { ERC20_ABI, USDC_ADDRESSES, CHAIN_KEY_TO_ID, arcTestnet } from "../providers";
import { baseSepolia, sepolia } from "wagmi/chains";
import { useWalletConnections } from "./WalletConnectionContext";
import { Connection as SolanaConnection, PublicKey as SolanaPublicKey } from "@solana/web3.js";
import { Asset, Horizon } from "@stellar/stellar-sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

const SOLANA_DEVNET_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const SOLANA_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOLANA_TOKEN_PROGRAM_ID = new SolanaPublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = new SolanaPublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const STELLAR_TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const STELLAR_USDC_CODE = "USDC";
const STELLAR_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function solanaAta(mint: SolanaPublicKey, owner: SolanaPublicKey): SolanaPublicKey {
  return SolanaPublicKey.findProgramAddressSync(
    [owner.toBuffer(), SOLANA_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

async function getSolanaBalances(addressStr: string): Promise<{ sol: number; usdc: number }> {
  try {
    const owner = new SolanaPublicKey(addressStr);
    const connection = new SolanaConnection(SOLANA_DEVNET_RPC_URL, "confirmed");
    const solBalanceLamports = await connection.getBalance(owner, "confirmed");
    const sol = solBalanceLamports / 1e9;
    
    let usdc = 0;
    try {
      const mint = new SolanaPublicKey(SOLANA_USDC_MINT);
      const sourceTokenAccount = solanaAta(mint, owner);
      const balRes = await connection.getTokenAccountBalance(sourceTokenAccount, "confirmed");
      usdc = Number(balRes.value.uiAmount ?? 0);
    } catch {
      usdc = 0;
    }
    return { sol, usdc };
  } catch (err) {
    console.error("Failed to get Solana balances:", err);
    return { sol: 0, usdc: 0 };
  }
}

async function getStellarBalances(addressStr: string): Promise<{ xlm: number; usdc: number }> {
  try {
    const server = new Horizon.Server(STELLAR_TESTNET_HORIZON_URL);
    const account = await server.loadAccount(addressStr);
    let xlm = 0;
    let usdc = 0;
    for (const bal of account.balances) {
      if (bal.asset_type === "native") {
        xlm = parseFloat(bal.balance);
      } else if (
        "asset_code" in bal &&
        bal.asset_code === STELLAR_USDC_CODE &&
        bal.asset_issuer === STELLAR_USDC_ISSUER
      ) {
        usdc = parseFloat(bal.balance);
      }
    }
    return { xlm, usdc };
  } catch (err) {
    console.error("Failed to get Stellar balances:", err);
    return { xlm: 0, usdc: 0 };
  }
}

const evmClients = {
  ARC: createPublicClient({
    chain: arcTestnet,
    transport: http("https://rpc.testnet.arc.network")
  }),
  BASE_SEPOLIA: createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org")
  }),
  ETHEREUM_SEPOLIA: createPublicClient({
    chain: sepolia,
    transport: http("https://sepolia.infura.io/v3/cea2942c462d447983f9f20783cd2f64")
  })
};

async function getEvmUsdcBalance(chainKey: "ARC" | "BASE_SEPOLIA" | "ETHEREUM_SEPOLIA", addressStr: string): Promise<string> {
  const chainId = CHAIN_KEY_TO_ID[chainKey];
  const client = evmClients[chainKey];
  const usdcAddr = USDC_ADDRESSES[chainId];
  if (!client || !usdcAddr) return "0.0000";
  try {
    const balance = await client.readContract({
      address: usdcAddr,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [addressStr as `0x${string}`]
    });
    return Number(formatUnits(balance as bigint, 6)).toFixed(4);
  } catch (err) {
    console.error(`Failed to get EVM USDC balance for ${chainKey}:`, err);
    return "0.0000";
  }
}

const NAV_ITEMS = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/execute", label: "Execute" },
  { href: "/app/transactions", label: "Transactions" },
  { href: "/app/receipts", label: "Receipts" },
  { href: "/app/terminal", label: "Terminal" }
];

const CHAIN_LABEL: Record<string, string> = {
  ARC: "Arc",
  BASE_SEPOLIA: "Base Sepolia",
  ETHEREUM_SEPOLIA: "Ethereum Sepolia",
  SOLANA_DEVNET: "Solana Devnet",
  STELLAR_TESTNET: "Stellar Testnet"
};

const EXPLORERS: Record<string, string> = {
  ARC: "https://testnet.arcscan.app/tx/",
  BASE_SEPOLIA: "https://sepolia.basescan.org/tx/",
  ETHEREUM_SEPOLIA: "https://sepolia.etherscan.io/tx/",
  SOLANA_DEVNET: "https://solscan.io/tx/",
  STELLAR_TESTNET: "https://stellar.expert/explorer/testnet/tx/"
};

function shortHash(value?: string | null) {
  if (!value) return "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function primaryTxAndChain(tx: TransactionResponse): { hash: string; chain: string } | null {
  // 1. If we have onChain transactions list, use the first one
  if (tx.onChain?.transactions?.[0]?.hash) {
    return {
      hash: tx.onChain.transactions[0].hash,
      chain: tx.onChain.transactions[0].chain
    };
  }

  // 2. Fall back to protocol execution (destination chain)
  if (typeof tx.protocolReceipt?.txHash === "string" && tx.protocolReceipt.txHash.length > 0) {
    return { hash: tx.protocolReceipt.txHash, chain: tx.input?.destinationChain ?? "ARC" };
  }
  if (typeof tx.protocolReceipt?.solanaTxHash === "string" && tx.protocolReceipt.solanaTxHash.length > 0) {
    return { hash: tx.protocolReceipt.solanaTxHash, chain: "SOLANA_DEVNET" };
  }
  if (typeof tx.protocolReceipt?.stellarTxHash === "string" && tx.protocolReceipt.stellarTxHash.length > 0) {
    return { hash: tx.protocolReceipt.stellarTxHash, chain: "STELLAR_TESTNET" };
  }

  // 3. Fall back to bridge execution
  if (typeof tx.bridgeReceipt?.txHash === "string" && tx.bridgeReceipt.txHash.length > 0) {
    return { hash: tx.bridgeReceipt.txHash, chain: tx.input?.destinationChain ?? "ARC" };
  }
  if (typeof tx.bridgeReceipt?.mintTxHash === "string" && tx.bridgeReceipt.mintTxHash.length > 0) {
    return { hash: tx.bridgeReceipt.mintTxHash, chain: tx.input?.destinationChain ?? "ARC" };
  }
  if (typeof tx.bridgeReceipt?.burnTxHash === "string" && tx.bridgeReceipt.burnTxHash.length > 0) {
    return { hash: tx.bridgeReceipt.burnTxHash, chain: tx.input?.sourceChain ?? "ARC" };
  }
  if (typeof tx.bridgeReceipt?.solanaTxHash === "string" && tx.bridgeReceipt.solanaTxHash.length > 0) {
    return { hash: tx.bridgeReceipt.solanaTxHash, chain: "SOLANA_DEVNET" };
  }
  if (typeof tx.bridgeReceipt?.stellarTxHash === "string" && tx.bridgeReceipt.stellarTxHash.length > 0) {
    return { hash: tx.bridgeReceipt.stellarTxHash, chain: "STELLAR_TESTNET" };
  }

  // 4. Fall back to user deposit (source chain)
  if (typeof tx.input?.metadata?.userDepositTxHash === "string" && tx.input.metadata.userDepositTxHash.length > 0) {
    return { hash: tx.input.metadata.userDepositTxHash, chain: tx.input?.sourceChain ?? "ARC" };
  }
  if (typeof tx.input?.metadata?.gatewayDepositTxHash === "string" && tx.input.metadata.gatewayDepositTxHash.length > 0) {
    return { hash: tx.input.metadata.gatewayDepositTxHash, chain: tx.input?.sourceChain ?? "ARC" };
  }
  if (typeof tx.input?.metadata?.gatewayApproveTxHash === "string" && tx.input.metadata.gatewayApproveTxHash.length > 0) {
    return { hash: tx.input.metadata.gatewayApproveTxHash, chain: tx.input?.sourceChain ?? "ARC" };
  }

  // 5. Fall back to receipt NFT (Arc Testnet)
  if (typeof tx.nftReceipt?.mintTxHash === "string" && tx.nftReceipt.mintTxHash.length > 0) {
    return { hash: tx.nftReceipt.mintTxHash, chain: "ARC" };
  }

  return null;
}

function primaryHash(tx: TransactionResponse) {
  return primaryTxAndChain(tx)?.hash ?? "";
}

function primaryHashChain(tx: TransactionResponse) {
  return primaryTxAndChain(tx)?.chain ?? "ARC";
}

function statusClass(status?: string) {
  if (status === "succeeded") return "is-good";
  if (status === "failed") return "is-bad";
  if (status === "needs_approval") return "is-warn";
  return "is-live";
}

function chainKeyFromId(chainId?: number) {
  if (chainId === arcTestnet.id) return "ARC";
  if (chainId === baseSepolia.id) return "BASE_SEPOLIA";
  if (chainId === sepolia.id) return "ETHEREUM_SEPOLIA";
  return undefined;
}

function formatTerminalBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function useDappConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${API_URL}/config`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((data) => { if (active) setConfig(data); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : String(err)); });
    return () => { active = false; };
  }, []);

  return { config, error };
}

export function useTransactions(limit = 50) {
  const { address } = useAccount();
  const { solanaAddress, stellarAddress } = useWalletConnections();
  const [data, setData] = useState<TransactionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(limit) });
    
    // Pass all connected wallets to retrieve unified history for EVM and non-EVM chains
    const owners = [address, solanaAddress, stellarAddress].filter(Boolean).join(",");
    if (owners) params.set("owner", owners);

    try {
      const res = await fetch(`${API_URL}/transactions?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [address, solanaAddress, stellarAddress, limit]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  return { data, loading, error, reload: load };
}

function BalanceCell({ chainId, label, address }: { chainId: number; label: string; address?: `0x${string}` }) {
  const { data, isLoading } = useReadContract({
    address: USDC_ADDRESSES[chainId],
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && USDC_ADDRESSES[chainId]) }
  });
  const value = data !== undefined ? Number(formatUnits(data as bigint, 6)).toFixed(4) : null;
  return (
    <article className="os-card balance-cell">
      <span>{label}</span>
      <strong>{address ? isLoading ? "syncing" : value ?? "0.0000" : "connect"}</strong>
      <small>USDC</small>
    </article>
  );
}

export function DappShell({ title, kicker, children }: { title: string; kicker: string; children: ReactNode }) {
  const pathname = usePathname();
  const { isConnected } = useAccount();
  const { data } = useTransactions(8);
  const activeCount = data?.transactions.filter((tx) => !["succeeded", "failed"].includes(tx.status ?? "")).length ?? 0;

  return (
    <main className="dapp-os">
      {/* Ambient Metamorphosis Background */}
      <div className="ambient-metamorphosis-container" aria-hidden="true">
        {/* Ambient Random Translucent Butterflies flying across the application */}
        <div className="ambient-butterfly ab-6">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-8">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-11">
          <img src="/raumv2logo.png" className="flap-fast" alt="" />
        </div>
        <div className="ambient-butterfly ab-14">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
        <div className="ambient-butterfly ab-17">
          <img src="/raumv2logo.png" className="flap-medium" alt="" />
        </div>
        <div className="ambient-butterfly ab-20">
          <img src="/raumv2logo.png" className="flap-slow" alt="" />
        </div>
      </div>

      <aside className="dapp-sidebar">
        <Link href="/" className="dapp-brand">
          <img src="/raumv2logo.png" alt="Arc logo" />
          <strong>Chrysalis</strong>
          <small>V2</small>
        </Link>
        <nav className="dapp-nav" aria-label="Dapp pages">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return <Link key={item.href} href={item.href} className={active ? "active" : ""}>{item.label}</Link>;
          })}
        </nav>
        <div className="sidebar-terminal">
          <span>system</span>
          <strong>{isConnected ? "wallet linked" : "wallet offline"}</strong>
          <small>{activeCount} active routes</small>
        </div>
      </aside>
      <section className="dapp-main">
        <header className="dapp-topbar">
          <div>
            <p>{kicker}</p>
            <h1>{title}</h1>
          </div>
          <AppWalletConnect />
        </header>
        {children}
      </section>
    </main>
  );
}

export function DashboardView() {
  const { address } = useAccount();
  const { config, error: configError } = useDappConfig();
  const { data, loading, error } = useTransactions(12);
  const txs = data?.transactions ?? [];
  const succeeded = txs.filter((tx) => tx.status === "succeeded").length;
  const failed = txs.filter((tx) => tx.status === "failed").length;
  const active = txs.length - succeeded - failed;

  return (
    <div className="dapp-stack">
      <section className="os-window hero-window">
        <div className="window-title"><span /><span /><span /><strong>live execution console</strong></div>
        <div className="dashboard-hero-grid">
          <div>
            <p className="os-kicker">on-chain only</p>
            <h2>Bridge, execute, store receipts.</h2>
            <p className="os-copy">Dashboard shows supported chains, wallet balances, route activity, and receipt status from live network state. Empty means no route has been executed yet.</p>
            <div className="hero-actions-row">
              <Link href="/app/execute" className="os-button primary">Build Route</Link>
              <Link href="/app/terminal" className="os-button">Open Terminal</Link>
            </div>
          </div>
          <div className="terminal-mini">
            <p>$ chrysalis status</p>
            <span>service: {configError ? "error" : config ? "online" : "syncing"}</span>
            <span>chains: {config?.chains.length ?? "--"}</span>
            <span>routes: {loading ? "--" : txs.length}</span>
          </div>
        </div>
      </section>

      <section className="metric-grid">
        <article className="os-card metric-card"><span>Routes</span><strong>{loading ? "--" : txs.length}</strong><small>cross-chain history</small></article>
        <article className="os-card metric-card"><span>In Flight</span><strong>{loading ? "--" : active}</strong><small>pending or finalizing</small></article>
        <article className="os-card metric-card"><span>Confirmed</span><strong>{loading ? "--" : succeeded}</strong><small>receipt ready</small></article>
        <article className="os-card metric-card"><span>Needs Review</span><strong>{loading ? "--" : failed}</strong><small>failed route</small></article>
      </section>

      <section className="balance-grid">
        <BalanceCell chainId={arcTestnet.id} label="Arc" address={address as `0x${string}` | undefined} />
        <BalanceCell chainId={baseSepolia.id} label="Base" address={address as `0x${string}` | undefined} />
        <BalanceCell chainId={sepolia.id} label="Ethereum" address={address as `0x${string}` | undefined} />
      </section>

      <TransactionTable title="Recent transactions" transactions={txs.slice(0, 6)} loading={loading} error={error} />
    </div>
  );
}

export function TransactionsView({ receiptsOnly = false }: { receiptsOnly?: boolean }) {
  const { data, loading, error, reload } = useTransactions(80);
  const txs = useMemo(() => {
    const items = data?.transactions ?? [];
    return receiptsOnly ? items.filter((tx) => tx.status === "succeeded" && tx.nftReceipt) : items;
  }, [data, receiptsOnly]);

  return (
    <div className="dapp-stack">
      <section className="os-window">
        <div className="window-title"><span /><span /><span /><strong>{receiptsOnly ? "receipt archive" : "transaction history + chain checks"}</strong></div>
        <div className="section-head">
          <div>
            <p className="os-kicker">live route history</p>
            <h2>{receiptsOnly ? "Receipt NFTs" : "Transactions"}</h2>
          </div>
          <button className="os-button" onClick={() => void reload()}>Refresh</button>
        </div>
        <TransactionTable transactions={txs} loading={loading} error={error} receiptsOnly={receiptsOnly} />
      </section>
    </div>
  );
}

export function TerminalView() {
  const { address, chain } = useAccount();
  const { solanaAddress, stellarAddress } = useWalletConnections();
  const [lines, setLines] = useState<string[]>([
    "Chrysalis terminal ready.",
    "Type help to see commands. Type swap 5 USDC on Base to WETH to build a route."
  ]);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<{ intent: any; quote: any; explanation: string } | null>(null);

  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const append = useCallback((next: string) => {
    setLines((prev) => [...prev, next]);
  }, []);

  async function fetchPath(label: string, path: string) {
    setRunning(true);
    append(`$ ${label}`);
    try {
      const res = await fetch(`${API_URL}${path}`);
      const body = await res.text();
      append(formatTerminalBody(body).slice(0, 3200));
    } catch (err) {
      append(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function askAI(message: string) {
    setRunning(true);
    append(`$ ${message}`);
    try {
      const res = await fetch(`${API_URL}/agents/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          connectedWallet: address,
          connectedChain: chainKeyFromId(chain?.id),
          solanaWallet: solanaAddress ?? undefined,
          stellarWallet: stellarAddress ?? undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? "AI agent failed");

      if (data.intent || data.quote) {
        // Store the route for user confirmation
        setPendingRoute({
          intent: data.intent ?? null,
          quote: data.quote ?? null,
          explanation: data.explanation ?? "AI decoded your route."
        });

        let routePreview = `${data.explanation ?? "Route decoded."}\n\n`;
        routePreview += "══════════════════════════════════════\n";
        routePreview += "  ROUTE PREVIEW\n";
        routePreview += "══════════════════════════════════════\n";

        if (data.intent) {
          const i = data.intent;
          if (i.sourceChain) routePreview += `  source:      ${CHAIN_LABEL[i.sourceChain] ?? i.sourceChain}\n`;
          if (i.destinationChain) routePreview += `  destination:  ${CHAIN_LABEL[i.destinationChain] ?? i.destinationChain}\n`;
          if (i.amount) routePreview += `  amount:       ${i.amount} ${i.asset ?? "USDC"}\n`;
          if (i.protocol) routePreview += `  protocol:     ${i.protocol}\n`;
          if (i.action) routePreview += `  action:       ${i.action}\n`;
          const extras = Object.entries(i).filter(([k]) => !["sourceChain","destinationChain","amount","asset","protocol","action"].includes(k));
          for (const [k, v] of extras) {
            routePreview += `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`;
          }
        }

        if (data.quote) {
          routePreview += "\n  quote details:\n";
          const q = data.quote;
          if (q.provider) routePreview += `    provider:    ${q.provider}\n`;
          if (q.fee) routePreview += `    fee:         ${q.fee}\n`;
          if (q.estimatedTime) routePreview += `    est. time:   ${q.estimatedTime}\n`;
          const qExtras = Object.entries(q).filter(([k]) => !["provider","fee","estimatedTime"].includes(k));
          for (const [k, v] of qExtras) {
            routePreview += `    ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`;
          }
        }

        routePreview += "\n══════════════════════════════════════\n";
        routePreview += "  type \"execute\" to confirm this route\n";
        routePreview += "  type \"cancel\" to discard\n";
        routePreview += "══════════════════════════════════════";

        append(routePreview.slice(0, 3600));
      } else {
        // No route — just show the explanation
        append(data.explanation ?? "No route decoded.");
      }
    } catch (err) {
      append(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function executePendingRoute() {
    if (!pendingRoute) {
      append("no pending route. type a swap/bridge command first.");
      return;
    }
    setRunning(true);
    append("$ execute\n\nsubmitting route...");
    try {
      const res = await fetch(`${API_URL}/intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...pendingRoute.intent,
          approved: true
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? "execution failed");
      append(`route submitted.\n\ntransaction id: ${data.id ?? "unknown"}\nstatus: ${data.status ?? "pending"}\n\ntrack progress in the Transactions tab or type \"transactions\".`);
      setPendingRoute(null);
    } catch (err) {
      append(`execution error: ${err instanceof Error ? err.message : String(err)}\n\nroute is still pending. type \"execute\" to retry or \"cancel\" to discard.`);
    } finally {
      setRunning(false);
    }
  }

  async function runCommand(raw: string) {
    const input = raw.trim();
    if (!input || running) return;
    const [name = "", ...rest] = input.split(/\s+/);
    const arg = rest.join(" ");
    setCommand("");

    switch (name.toLowerCase()) {
      case "help":
      case "?":
        append(`$ ${input}\n\ncommands:\n  help                  show command menu\n  balance               read connected wallet balances\n  transactions | tx     list route history + live chain status\n  health                service health check\n  config                supported chains/protocols\n  execute | confirm     submit a pending route\n  cancel                discard a pending route\n  clear                 clear terminal\n  [any other text]      ask AI to build/explain route`);
        return;
      case "execute":
      case "confirm":
        await executePendingRoute();
        return;
      case "cancel":
      case "discard":
        if (pendingRoute) {
          setPendingRoute(null);
          append(`$ ${input}\n\nroute discarded.`);
        } else {
          append(`$ ${input}\n\nno pending route to cancel.`);
        }
        return;
      case "route":
        append(`$ ${input}\n\nopening route builder...`);
        window.location.href = "/app/execute";
        return;
      case "balance":
      case "balances": {
        const hasEvm = Boolean(address);
        const hasSol = Boolean(solanaAddress);
        const hasStel = Boolean(stellarAddress);

        if (!hasEvm && !hasSol && !hasStel) {
          append(`$ ${input}\n\nconnect a wallet first, then run balance again.`);
          return;
        }

        setRunning(true);
        append(`$ ${input}\n\nfetching connected wallet balances...`);

        try {
          let outputText = "connected wallets and balances:\n";

          if (hasEvm) {
            outputText += `\n[evm] ${address}\n`;
            
            // 1. Fetch live ERC20 wallet balances on-chain
            outputText += `  on-chain wallet balances:\n`;
            try {
              const arcBal = await getEvmUsdcBalance("ARC", address!);
              const baseBal = await getEvmUsdcBalance("BASE_SEPOLIA", address!);
              const ethBal = await getEvmUsdcBalance("ETHEREUM_SEPOLIA", address!);
              
              outputText += `    - Arc: ${arcBal} USDC\n`;
              outputText += `    - Base Sepolia: ${baseBal} USDC\n`;
              outputText += `    - Ethereum Sepolia: ${ethBal} USDC\n`;
            } catch (err) {
              outputText += `    - error: ${err instanceof Error ? err.message : String(err)}\n`;
            }

            // 2. Fetch Circle Gateway deposits
            outputText += `  circle gateway deposits:\n`;
            try {
              const res = await fetch(`${API_URL}/gateway/balances/${address}`);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = await res.json();
              if (data?.balances && Array.isArray(data.balances)) {
                const validBalances = data.balances.filter((bal: any) => bal.chain && CHAIN_LABEL[bal.chain]);
                if (validBalances.length > 0) {
                  for (const bal of validBalances) {
                    const chainLabel = CHAIN_LABEL[bal.chain] ?? bal.chain;
                    outputText += `    - ${chainLabel}: ${bal.amount} ${bal.asset}\n`;
                  }
                } else {
                  outputText += "    - (no gateway deposits found)\n";
                }
              } else {
                outputText += "    - (no gateway deposits found)\n";
              }
            } catch (err) {
              outputText += `    - error: ${err instanceof Error ? err.message : String(err)}\n`;
            }
          }

          if (hasSol) {
            outputText += `\n[solana] ${solanaAddress}\n`;
            try {
              const solBals = await getSolanaBalances(solanaAddress!);
              outputText += `  - Solana Devnet: ${solBals.sol.toFixed(4)} SOL, ${solBals.usdc.toFixed(4)} USDC\n`;
            } catch (err) {
              outputText += `  - error: ${err instanceof Error ? err.message : String(err)}\n`;
            }
          }

          if (hasStel) {
            outputText += `\n[stellar] ${stellarAddress}\n`;
            try {
              const stelBals = await getStellarBalances(stellarAddress!);
              outputText += `  - Stellar Testnet: ${stelBals.xlm.toFixed(4)} XLM, ${stelBals.usdc.toFixed(4)} USDC\n`;
            } catch (err) {
              outputText += `  - error: ${err instanceof Error ? err.message : String(err)}\n`;
            }
          }

          append(outputText.trim());
        } catch (err) {
          append(`error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setRunning(false);
        }
        return;
      }
      case "transactions":
      case "tx": {
        const owners = [address, solanaAddress, stellarAddress].filter(Boolean).join(",");
        await fetchPath(input, `/transactions?limit=20${owners ? `&owner=${owners}` : ""}`);
        return;
      }
      case "health":
        await fetchPath(input, "/health");
        return;
      case "config":
        await fetchPath(input, "/config");
        return;
      case "clear":
        setLines(["Chrysalis terminal ready.", "Type help to see commands."]);
        return;
      default: {
        // If user typed something while a route is pending, warn them
        if (pendingRoute && !["execute", "confirm", "cancel", "discard"].includes(name.toLowerCase())) {
          append(`$ ${input}\n\nyou have a pending route. type "execute" to confirm or "cancel" to discard before building a new route.`);
          return;
        }
        let cleanInput = input;
        if (input.toLowerCase().startsWith("ai ")) {
          cleanInput = input.substring(3).trim();
        } else if (input.toLowerCase().startsWith("ask ")) {
          cleanInput = input.substring(4).trim();
        }
        await askAI(cleanInput);
        return;
      }
    }
  }

  return (
    <div className="terminal-layout">
      <section className="os-window terminal-window">
        <div className="window-title"><span /><span /><span /><strong>terminal</strong></div>
        <pre ref={outputRef} className="terminal-output">{lines.join("\n\n")}</pre>
        <form className="terminal-prompt" onSubmit={(e) => {
          e.preventDefault();
          void runCommand(command);
        }}>
          <span>$</span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={pendingRoute ? "type execute to confirm or cancel to discard..." : "help, balance, tx, swap 5 USDC on Base to WETH..."}
            disabled={running}
            autoComplete="off"
          />
          <button type="submit" disabled={running || !command.trim()}>{running ? "run..." : "enter"}</button>
        </form>
      </section>
      <aside className="os-window command-window">
        <div className="window-title"><span /><span /><span /><strong>commands</strong></div>
        <button disabled={running} onClick={() => void runCommand("help")}>help</button>
        <button disabled={running} onClick={() => void runCommand("execute")}>execute</button>
        <button disabled={running} onClick={() => void runCommand("balance")}>balance</button>
        <button disabled={running} onClick={() => void runCommand("transactions")}>transactions</button>
        <button disabled={running} onClick={() => void runCommand("health")}>health</button>
        <button disabled={running} onClick={() => void runCommand("config")}>config</button>
      </aside>
    </div>
  );
}

function TransactionTable({ title, transactions, loading, error, receiptsOnly }: {
  title?: string;
  transactions: TransactionResponse[];
  loading: boolean;
  error: string | null;
  receiptsOnly?: boolean;
}) {
  const [selectedTx, setSelectedTx] = useState<TransactionResponse | null>(null);
  const [enrichedTx, setEnrichedTx] = useState<TransactionResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  useEffect(() => {
    if (!selectedTx) {
      setEnrichedTx(null);
      setLoadingStatus(false);
      return;
    }
    
    // Set initial state from the list item so the user sees the steps and hashes instantly!
    setEnrichedTx(selectedTx);
    setLoadingStatus(true);

    let active = true;
    
    // Fetch the detailed status from the backend slowly/only when requested
    fetch(`${API_URL}/transactions/${selectedTx.id}/status`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch status");
        return res.json();
      })
      .then((data) => {
        if (active) {
          setEnrichedTx(data);
          setLoadingStatus(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load tx status:", err);
        if (active) setLoadingStatus(false);
      });

    return () => {
      active = false;
    };
  }, [selectedTx]);

  return (
    <section className="os-window table-window">
      {title && <div className="window-title"><span /><span /><span /><strong>{title}</strong></div>}
      {error && <p className="os-error">{error}</p>}
      {loading && <p className="empty-state">Syncing live transactions...</p>}
      {!loading && transactions.length === 0 && <p className="empty-state">No on-chain transaction records found.</p>}
      {transactions.length > 0 && (
        <div className="tx-table">
          {transactions.map((tx) => {
            const hash = primaryHash(tx);
            const hashChain = primaryHashChain(tx);
            const sourceChain = tx.input?.sourceChain ?? "";
            const destinationChain = tx.input?.destinationChain ?? "";
            const fallbackExpUrl = hashChain === "SOLANA_DEVNET" ? "https://explorer.solana.com/tx/" : (EXPLORERS[hashChain] ?? EXPLORERS.ARC);
            const href = hash ? `${fallbackExpUrl}${hash}${hashChain === "SOLANA_DEVNET" ? "?cluster=devnet" : ""}` : "";
            
            return (
              <article key={tx.id} className="tx-row" onClick={() => setSelectedTx(tx)} style={{ cursor: "pointer" }}>
                <div>
                  <strong>{tx.input?.amount} {tx.input?.asset}</strong>
                  <span>{CHAIN_LABEL[sourceChain] ?? sourceChain} -&gt; {CHAIN_LABEL[destinationChain] ?? destinationChain}</span>
                </div>
                <div>
                  <strong>{tx.input?.protocol}</strong>
                  <span>{tx.input?.action}</span>
                </div>
                <div>
                  <span className={`status-pill ${statusClass(tx.status)}`}>{tx.status}</span>
                  {tx.onChain?.transactions?.length ? <small>{tx.onChain.transactions.filter((item) => item.status.confirmed).length}/{tx.onChain.transactions.length} confirmed</small> : <small>no tx hash</small>}
                </div>
                <div className="tx-links-column" onClick={(e) => e.stopPropagation()}>
                  {receiptsOnly && tx.nftReceipt?.tokenId && <strong style={{ display: "block", marginBottom: "4px" }}>#{tx.nftReceipt.tokenId}</strong>}
                  {tx.onChain?.transactions?.length ? (
                    <div className="tx-links-list">
                      {tx.onChain.transactions.map((t) => {
                        const expUrl = EXPLORERS[t.chain] ?? EXPLORERS.ARC;
                        const finalExpUrl = t.chain === "SOLANA_DEVNET" ? "https://explorer.solana.com/tx/" : expUrl;
                        const linkHref = `${finalExpUrl}${t.hash}${t.chain === "SOLANA_DEVNET" ? "?cluster=devnet" : ""}`;
                        return (
                          <a
                            key={t.hash}
                            href={linkHref}
                            target="_blank"
                            rel="noreferrer"
                            className="tx-link-item"
                            title={`${t.label} (on ${CHAIN_LABEL[t.chain] ?? t.chain})`}
                          >
                            {t.label} ↗
                          </a>
                        );
                      })}
                    </div>
                  ) : hash ? (
                    <a href={href} target="_blank" rel="noreferrer" className="tx-link-item">
                      View Tx ↗
                    </a>
                  ) : (
                    <span>pending</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Route Details Modal */}
      {selectedTx && enrichedTx && (
        <div className="os-modal-overlay" onClick={() => setSelectedTx(null)}>
          <div className="os-window modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="window-title">
              <span />
              <span />
              <span />
              <strong>
                Route execution logs
                {loadingStatus && (
                  <span style={{ fontSize: "11px", color: "var(--r-blue, #2d6cdf)", marginLeft: "10px", textTransform: "lowercase", fontWeight: "normal", fontFamily: "monospace" }}>
                    (syncing status...)
                  </span>
                )}
              </strong>
              <button className="close-btn" onClick={() => setSelectedTx(null)}>×</button>
            </div>
            <div className="modal-body">
              <header className="modal-header-summary">
                <div>
                  <p className="os-kicker">route pipeline overview</p>
                  <h2>{enrichedTx.input?.amount} {enrichedTx.input?.asset}</h2>
                  <span>{CHAIN_LABEL[enrichedTx.input?.sourceChain ?? ""] ?? enrichedTx.input?.sourceChain} → {CHAIN_LABEL[enrichedTx.input?.destinationChain ?? ""] ?? enrichedTx.input?.destinationChain}</span>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className={`status-pill ${statusClass(enrichedTx.status)}`} style={{ fontSize: "14px", padding: "6px 12px" }}>
                    {enrichedTx.status}
                  </span>
                  <small style={{ display: "block", marginTop: "6px", color: "#6b7280", fontFamily: "monospace" }}>ID: {enrichedTx.id}</small>
                </div>
              </header>

              <div className="modal-details-grid">
                <div>
                  <strong>Protocol</strong>
                  <span>{enrichedTx.input?.protocol} ({enrichedTx.input?.action})</span>
                </div>
                <div>
                  <strong>Preferred Rail</strong>
                  <span>{enrichedTx.input?.preferredRoute ?? "Auto"}</span>
                </div>
                <div>
                  <strong>Recipient Address</strong>
                  <span style={{ fontSize: "12px", fontFamily: "monospace", wordBreak: "break-all" }}>{enrichedTx.input?.recipient ?? "none"}</span>
                </div>
              </div>

              <section className="modal-pipeline-section">
                <h3>On-Chain Execution Pipeline</h3>
                {enrichedTx.onChain?.transactions?.length ? (
                  <div className="modal-steps-timeline">
                    {enrichedTx.onChain.transactions.map((t, idx) => {
                      const expUrl = EXPLORERS[t.chain] ?? EXPLORERS.ARC;
                      const finalExpUrl = t.chain === "SOLANA_DEVNET" ? "https://explorer.solana.com/tx/" : expUrl;
                      const linkHref = `${finalExpUrl}${t.hash}${t.chain === "SOLANA_DEVNET" ? "?cluster=devnet" : ""}`;
                      return (
                        <div key={t.hash} className="modal-step-row">
                          <div className="step-indicator">
                            <span className={`step-dot ${t.status.confirmed ? "confirmed" : "pending"}`} />
                            {idx < enrichedTx.onChain!.transactions.length - 1 && <div className="step-line" />}
                          </div>
                          <div className="step-details">
                            <div className="step-header">
                              <strong>{t.label}</strong>
                              <span className={`status-pill ${t.status.confirmed ? "is-good" : "is-live"}`} style={{ fontSize: "10px", padding: "2px 6px" }}>
                                {t.status.confirmed ? "confirmed" : t.status.found ? "found" : "pending"}
                              </span>
                            </div>
                            <div className="step-meta">
                              <span>Chain: {CHAIN_LABEL[t.chain] ?? t.chain}</span>
                              {t.hash ? (
                                <a href={linkHref} target="_blank" rel="noreferrer" className="step-hash-link">
                                  {t.hash.slice(0, 12)}...{t.hash.slice(-10)} ↗
                                </a>
                              ) : (
                                <span>no hash yet</span>
                              )}
                            </div>
                            {t.status.blockNumber && <small className="step-block" style={{ display: "block", marginTop: "2px", color: "#6b7280", fontSize: "11px" }}>Block: {t.status.blockNumber}</small>}
                            {t.status.error ? <p className="step-error" style={{ color: "var(--r-red, #f04438)", margin: "4px 0 0", fontSize: "11px" }}>Error: {String(t.status.error)}</p> : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="empty-state" style={{ padding: "20px 0" }}>No on-chain transaction hashes are available yet. The route is pending execution or local.</p>
                )}
              </section>

              {enrichedTx.aiNarration && (
                <section className="modal-narration-section" style={{ marginTop: "24px", padding: "16px", border: "1px solid var(--r-line, #16151c)", background: "#f8f9fc" }}>
                  <h3 style={{ margin: "0 0 8px", fontSize: "12px", fontFamily: "monospace", textTransform: "uppercase", color: "var(--r-red, #f04438)" }}>AI Narration</h3>
                  <p style={{ margin: 0, fontSize: "13px", color: "#333", lineHeight: "1.6" }}>{enrichedTx.aiNarration}</p>
                </section>
              )}

              <details className="modal-raw-json" style={{ marginTop: "24px" }}>
                <summary style={{ cursor: "pointer", fontSize: "12px", fontFamily: "monospace", color: "#6b7280" }}>Developer JSON Logs</summary>
                <pre style={{ marginTop: "8px", padding: "12px", background: "#16151c", color: "#a5b4fc", fontSize: "11px", overflowX: "auto", fontFamily: "monospace" }}>
                  {JSON.stringify(enrichedTx, null, 2)}
                </pre>
              </details>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
