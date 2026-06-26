"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, createPublicClient, http } from "viem";
import { useAccount, usePublicClient, useReadContract, useSignTypedData, useWriteContract } from "wagmi";
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
const ARC_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

const GATEWAY_WALLET_ABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "value", type: "uint256" }], outputs: [] },
] as const;

const TERMINAL_SWAP_TOKENS: Record<string, Record<string, string>> = {
  BASE_SEPOLIA: {
    WETH: "0x4200000000000000000000000000000000000006"
  },
  ETHEREUM_SEPOLIA: {
    WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
  }
};

const TERMINAL_PROTOCOL_CHAIN: Record<string, string> = {
  ARC_USDC_TRANSFER: "ARC",
  ARC_USYC_TELLER: "ARC",
  BASE_USDC_TRANSFER: "BASE_SEPOLIA",
  BASE_UNISWAP_V3: "BASE_SEPOLIA",
  BASE_MORPHO_BLUE: "BASE_SEPOLIA",
  ETH_USDC_TRANSFER: "ETHEREUM_SEPOLIA",
  ETH_UNISWAP_V3: "ETHEREUM_SEPOLIA",
  ETH_AAVE_V3: "ETHEREUM_SEPOLIA",
  SOL_USDC_TRANSFER: "SOLANA_DEVNET",
  SOL_MARINADE: "SOLANA_DEVNET",
  XLM_USDC_TRANSFER: "STELLAR_TESTNET",
  XLM_AQUARIUS: "STELLAR_TESTNET",
  XLM_BLEND: "STELLAR_TESTNET"
};

const TERMINAL_PROTOCOL_DEFAULT_ACTION: Record<string, string> = {
  ARC_USDC_TRANSFER: "transfer",
  BASE_USDC_TRANSFER: "transfer",
  ETH_USDC_TRANSFER: "transfer",
  SOL_USDC_TRANSFER: "transfer",
  XLM_USDC_TRANSFER: "transfer",
  ARC_USYC_TELLER: "supply",
  BASE_UNISWAP_V3: "swap",
  ETH_UNISWAP_V3: "swap",
  BASE_MORPHO_BLUE: "supply",
  ETH_AAVE_V3: "supply",
  SOL_MARINADE: "Deposit",
  XLM_AQUARIUS: "Swap",
  XLM_BLEND: "supply"
};

const TERMINAL_ROUTE_ALIASES: Record<string, string> = {
  gateway: "GATEWAY",
  cctp: "CCTP_V2",
  cctpv2: "CCTP_V2",
  cctp_v2: "CCTP_V2",
  bridgekit: "BRIDGEKIT",
  local: "LOCAL"
};

const TERMINAL_CHAIN_ALIASES: Record<string, string> = {
  arc: "ARC",
  base: "BASE_SEPOLIA",
  "base sepolia": "BASE_SEPOLIA",
  ethereum: "ETHEREUM_SEPOLIA",
  eth: "ETHEREUM_SEPOLIA",
  sepolia: "ETHEREUM_SEPOLIA",
  solana: "SOLANA_DEVNET",
  "solana devnet": "SOLANA_DEVNET",
  stellar: "STELLAR_TESTNET",
  "stellar testnet": "STELLAR_TESTNET"
};

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

const GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 + 100;

function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function buildGatewayPaymentAuth(from: `0x${string}`, requirement: any) {
  const chainId = Number(String(requirement.network).replace("eip155:", ""));
  const now = Math.floor(Date.now() / 1000);
  const validBefore = now + Math.max(Number(requirement.maxTimeoutSeconds ?? 0), GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS);
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
    domain: { name: "GatewayWalletBatched", version: "1", chainId, verifyingContract: requirement.extra.verifyingContract } as const,
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

function encodeBase64Json(value: Record<string, unknown>) {
  return btoa(JSON.stringify(value));
}

function decodeBase64Json<T = any>(value: string): T {
  return JSON.parse(atob(value)) as T;
}

function formatTerminalBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function normalizeTerminalIntent(intent: any, wallets: {
  address?: string;
  solanaAddress?: string | null;
  stellarAddress?: string | null;
  connectedChain?: string;
}) {
  const protocol = normalizeTerminalProtocol(intent.protocol, intent.destinationChain);
  const protocolChain = TERMINAL_PROTOCOL_CHAIN[protocol];
  const destinationChain = protocolChain
    ?? intent.destinationChain
    ?? (protocol.startsWith("SOL_") ? "SOLANA_DEVNET" : protocol.startsWith("XLM_") ? "STELLAR_TESTNET" : wallets.connectedChain ?? "ARC");
  const recipient = intent.recipient
    ?? (destinationChain === "SOLANA_DEVNET" ? wallets.solanaAddress : destinationChain === "STELLAR_TESTNET" ? wallets.stellarAddress : wallets.address)
    ?? undefined;
  const tokenOutValue = intent.metadata?.tokenOut;
  const resolvedTokenOut = resolveTerminalTokenOut(destinationChain, tokenOutValue);
  const metadata = {
    ...(intent.metadata ?? {}),
    ...(resolvedTokenOut ? { tokenOut: resolvedTokenOut.address, tokenOutSymbol: resolvedTokenOut.symbol } : {}),
    ...(wallets.address ? { sourceWalletAddress: wallets.address, evmReceiptWalletAddress: wallets.address } : {}),
    ...(wallets.solanaAddress ? { solanaAddress: wallets.solanaAddress } : {}),
    ...(wallets.stellarAddress ? { stellarAddress: wallets.stellarAddress } : {}),
    ...(recipient ? { destinationRecipient: recipient } : {})
  };
  return {
    sourceChain: intent.sourceChain ?? wallets.connectedChain ?? "ARC",
    destinationChain,
    asset: intent.asset ?? "USDC",
    amount: intent.amount ?? "0.05",
    protocol,
    action: normalizeTerminalAction(protocol, intent.action),
    autonomous: intent.autonomous ?? true,
    recipient,
    slippageBps: intent.slippageBps ?? 50,
    optimizationGoal: intent.optimizationGoal ?? "balanced",
    preferredRoute: intent.preferredRoute,
    maxTotalFeeUsd: intent.maxTotalFeeUsd,
    metadata
  };
}

function normalizeTerminalProtocol(protocol: unknown, destinationChain?: string): string {
  if (typeof protocol === "string" && protocol.trim()) return protocol.trim();
  if (destinationChain === "BASE_SEPOLIA") return "BASE_UNISWAP_V3";
  if (destinationChain === "SOLANA_DEVNET") return "SOL_MARINADE";
  if (destinationChain === "STELLAR_TESTNET") return "XLM_BLEND";
  return "ETH_AAVE_V3";
}

function normalizeTerminalAction(protocol: string, action: unknown): string {
  const raw = typeof action === "string" ? action.trim() : "";
  if (protocol === "SOL_MARINADE" && ["stake", "supply", "deposit"].includes(raw.toLowerCase())) return "Deposit";
  if (protocol === "XLM_AQUARIUS" && raw.toLowerCase() === "swap") return "Swap";
  return raw || TERMINAL_PROTOCOL_DEFAULT_ACTION[protocol] || "supply";
}

function validateTerminalIntent(intent: any): string | null {
  if (intent.sourceChain === intent.destinationChain) {
    return `Same-chain route disabled in terminal: source and destination are both ${CHAIN_LABEL[intent.sourceChain] ?? intent.sourceChain}. Pick a different source or destination chain.`;
  }
  const protocolChain = TERMINAL_PROTOCOL_CHAIN[intent.protocol];
  if (protocolChain && intent.destinationChain !== protocolChain) {
    return `${intent.protocol} runs on ${CHAIN_LABEL[protocolChain] ?? protocolChain}, not ${CHAIN_LABEL[intent.destinationChain] ?? intent.destinationChain}.`;
  }
  if (intent.protocol === "BASE_UNISWAP_V3" || intent.protocol === "ETH_UNISWAP_V3") {
    const tokenOut = intent.metadata?.tokenOut;
    if (typeof tokenOut !== "string" || !tokenOut.startsWith("0x")) {
      return `${intent.protocol} swap needs a known tokenOut address. Try WETH or use a contract address.`;
    }
  }
  return null;
}

function terminalRoutePatch(message: string): Record<string, unknown> | null {
  const text = message.toLowerCase();
  const patch: Record<string, unknown> = {};
  for (const [alias, routeKind] of Object.entries(TERMINAL_ROUTE_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`, "i").test(text)) patch.preferredRoute = routeKind;
  }
  const amountMatch = text.match(/\b(?:amount|for|of)?\s*(\d+(?:\.\d+)?)\s*(?:usdc)?\b/);
  if (amountMatch && !/\beip155\b/.test(text)) patch.amount = amountMatch[1];
  for (const [alias, chainKey] of Object.entries(TERMINAL_CHAIN_ALIASES)) {
    if (new RegExp(`\\bfrom\\s+${alias}\\b`, "i").test(text)) patch.sourceChain = chainKey;
    if (new RegExp(`\\b(?:to|on|onto|for)\\s+${alias}\\b`, "i").test(text)) patch.destinationChain = chainKey;
  }
  if (/\bfastest\b/.test(text)) patch.optimizationGoal = "fastest";
  if (/\blowest(?:\s|-)?cost\b|\bcheapest\b/.test(text)) patch.optimizationGoal = "lowest_cost";
  if (/\bsafest\b/.test(text)) patch.optimizationGoal = "safest";
  if (/\bbalanced\b/.test(text)) patch.optimizationGoal = "balanced";
  if (/\bswap\b/.test(text)) patch.action = "swap";
  if (/\bweth\b/.test(text)) patch.metadata = { tokenOut: "WETH", tokenOutSymbol: "WETH" };
  return Object.keys(patch).length > 0 ? patch : null;
}

function mergeTerminalIntent(previous: any, next: any) {
  const merged = {
    ...previous,
    ...(next ?? {}),
    metadata: {
      ...(previous?.metadata ?? {}),
      ...(next?.metadata ?? {})
    }
  };
  if (next?.destinationChain && next.destinationChain !== previous?.destinationChain && !next?.protocol) {
    delete (merged as any).protocol;
  }
  if (next?.destinationChain && next.destinationChain !== previous?.destinationChain && !next?.metadata?.tokenOut) {
    delete merged.metadata.tokenOut;
    delete merged.metadata.tokenOutSymbol;
  }
  return merged;
}

function resolveTerminalTokenOut(destinationChain: string, value: unknown): { address: string; symbol: string } | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value.startsWith("0x") && value.length === 42) {
    const known = Object.entries(TERMINAL_SWAP_TOKENS[destinationChain] ?? {})
      .find(([, address]) => address.toLowerCase() === value.toLowerCase());
    return { address: value, symbol: known?.[0] ?? "Selected token" };
  }
  const symbol = value.trim().toUpperCase();
  const address = TERMINAL_SWAP_TOKENS[destinationChain]?.[symbol];
  return address ? { address, symbol } : undefined;
}

function terminalMetadataSummary(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const value = metadata as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof value.tokenOutSymbol === "string") parts.push(`tokenOut ${value.tokenOutSymbol}`);
  else if (typeof value.tokenOut === "string") parts.push(`tokenOut ${shortHash(value.tokenOut)}`);
  if (typeof value.sourceWalletAddress === "string") parts.push(`source ${shortHash(value.sourceWalletAddress)}`);
  if (typeof value.destinationRecipient === "string") parts.push(`dest ${shortHash(value.destinationRecipient)}`);
  if (typeof value.solanaAddress === "string") parts.push(`sol ${shortHash(value.solanaAddress)}`);
  if (typeof value.stellarAddress === "string") parts.push(`stellar ${shortHash(value.stellarAddress)}`);
  return parts.join(" | ");
}

function terminalStepForStatus(status: string, receipt: any) {
  switch (status) {
    case "created": return "AIAssistant decoded intent";
    case "quoted": return "FeeQuoteAgent produced quote";
    case "planned": return `RoutePlannerAgent selected ${receipt.plan?.routeKind ?? "route"}`;
    case "bridging": return `Circle rail executing ${receipt.plan?.routeKind ?? receipt.input?.preferredRoute ?? "bridge"}`;
    case "executing": return `ProtocolActionAgent executing ${receipt.input?.protocol ?? "protocol"} ${receipt.input?.action ?? ""}`.trim();
    case "finalizing": return "JudgeNarratorAgent minting Arc receipt + narration";
    case "succeeded": return "route complete";
    case "failed": return "route failed";
    case "needs_approval": return "policy requires approval";
    default: return status;
  }
}

function terminalRouteBlockReason(route: any): string | null {
  const plan = route?.analysis?.plan ?? route?.quote?.plan ?? {};
  const selected = route?.quote?.selected ?? plan?.feeQuote;
  if (route?.analysis?.policy?.allowed === false) {
    const reasons = Array.isArray(route.analysis.policy.reasons) ? route.analysis.policy.reasons.join("; ") : "Risk policy blocked this route.";
    return `RiskPolicyAgent blocked this route: ${reasons}`;
  }
  if (!selected) {
    const alternatives = Array.isArray(plan?.alternatives) ? plan.alternatives : [];
    const reasons = alternatives
      .flatMap((alt: any) => Array.isArray(alt.rejectionReasons) ? alt.rejectionReasons : alt.reason ? [alt.reason] : [])
      .filter(Boolean)
      .slice(0, 3);
    return reasons.length > 0
      ? `No executable route found: ${reasons.join(" | ")}`
      : "No executable route found. Replan with a different chain, protocol, or route.";
  }
  if (plan?.routeKind === "MOCK" || selected?.routeKind === "MOCK") {
    const reason = Array.isArray(plan?.rationale) ? plan.rationale.find((item: string) => /mock|not eligible|no eligible|simulation/i.test(item)) : "";
    return reason || "RoutePlannerAgent selected MOCK, so terminal will not move funds.";
  }
  return null;
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

export function useTransactions(limit = 50, requireConnection = false) {
  const { address } = useAccount();
  const { solanaAddress, stellarAddress } = useWalletConnections();
  const [data, setData] = useState<TransactionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const owners = [address, solanaAddress, stellarAddress].filter(Boolean).join(",");
    if (!owners && requireConnection) {
      setData({ source: "memory", count: 0, transactions: [] });
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(limit) });
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
  }, [address, solanaAddress, stellarAddress, limit, requireConnection]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  return { data, loading, error, reload: load };
}

function BalanceCell({ chainId, label, address }: { chainId: number; label: string; address?: `0x${string}` }) {
  const { data, isLoading } = useReadContract({
    chainId,
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

export function DappShell({ title, children }: { title: string; kicker?: string; children: ReactNode }) {
  const pathname = usePathname();
  const { isConnected } = useAccount();
  const { data } = useTransactions(8, true);
  const activeCount = data?.transactions.filter((tx) => !["succeeded", "failed"].includes(tx.status ?? "")).length ?? 0;

  const [showButterflies, setShowButterflies] = useState(true);
  const [theme, setTheme] = useState("light");

  // Load preferences on mount
  useEffect(() => {
    const savedButterflies = localStorage.getItem("chrysalis_show_butterflies");
    if (savedButterflies === "false") {
      setShowButterflies(false);
    }
    const savedTheme = localStorage.getItem("chrysalis_theme");
    if (savedTheme === "dark") {
      setTheme("dark");
    }
  }, []);

  const toggleButterflies = () => {
    setShowButterflies((prev) => {
      const next = !prev;
      localStorage.setItem("chrysalis_show_butterflies", String(next));
      return next;
    });
  };

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem("chrysalis_theme", next);
      return next;
    });
  };

  return (
    <main className={`dapp-os${theme === "dark" ? " dark" : ""}`}>
      {/* Ambient Metamorphosis Background */}
      {showButterflies && (
        <div className="ambient-metamorphosis-container" aria-hidden="true">
          {/* Ambient Random Translucent Butterflies flying across the application */}
          <div className="ambient-butterfly ab-6">
            <img src="/raumv2logo.png" className="flap-medium" alt="" />
          </div>
          <div className="ambient-butterfly ab-11">
            <img src="/raumv2logo.png" className="flap-fast" alt="" />
          </div>
          <div className="ambient-butterfly ab-17">
            <img src="/raumv2logo.png" className="flap-medium" alt="" />
          </div>
          <div className="ambient-butterfly ab-20">
            <img src="/raumv2logo.png" className="flap-slow" alt="" />
          </div>
        </div>
      )}

      <aside className="dapp-sidebar">
        <Link href="/" className="dapp-brand">
          <img src="/raumv2logo.png" alt="Chrysalis logo" />
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span>butterflies</span>
            <button
              type="button"
              onClick={toggleButterflies}
              style={{
                background: showButterflies ? "var(--os-blue, #2d6cdf)" : "var(--os-window, #fff)",
                color: showButterflies ? "#fff" : "var(--os-ink, #16151c)",
                border: "2px solid var(--os-line, #16151c)",
                padding: "2px 8px",
                fontSize: "10px",
                fontFamily: "var(--os-font-mono, monospace)",
                fontWeight: "bold",
                cursor: "pointer",
                boxShadow: showButterflies ? "1px 1px 0 var(--os-line, #16151c)" : "2px 2px 0 var(--os-line, #16151c)",
                transform: showButterflies ? "translate(1px, 1px)" : "none",
                transition: "all 0.1s ease"
              }}
            >
              {showButterflies ? "ON" : "OFF"}
            </button>
          </div>
          <div style={{ borderTop: "1px dashed var(--os-line, #16151c)", opacity: 0.3, margin: "6px 0" }} />
          <span>system</span>
          <strong>{isConnected ? "wallet linked" : "wallet offline"}</strong>
          <small>{activeCount} active routes</small>
        </div>
      </aside>
      <section className="dapp-main">
        <header className="dapp-topbar">
          <div>
            <h1>{title}</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              type="button"
              onClick={toggleTheme}
              className="os-button"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                fontSize: "11px",
                fontWeight: "bold",
                cursor: "pointer",
                background: theme === "dark" ? "#222235" : "#fff",
                color: theme === "dark" ? "#ffd24a" : "#16151c",
                border: "2px solid var(--os-line)",
                minHeight: "36px",
                boxShadow: theme === "dark" ? "2px 2px 0 rgba(0,0,0,.4)" : "3px 3px 0 var(--os-line)",
                transform: theme === "dark" ? "translate(1px, 1px)" : "none",
                transition: "all 0.1s ease"
              }}
              title="Toggle Theme"
            >
              {theme === "dark" ? "🌙" : "☀️"}
            </button>
            <AppWalletConnect />
          </div>
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

  const isConnected = Boolean(address);
  const showRoutes = isConnected && !loading ? txs.length : "--";
  const showActive = isConnected && !loading ? active : "--";
  const showSucceeded = isConnected && !loading ? succeeded : "--";
  const showFailed = isConnected && !loading ? failed : "--";

  return (
    <div className="dapp-stack">
      <section className="os-window hero-window">
        <div className="window-title"><span /><span /><span /><strong>live execution console</strong></div>
        <div className="dashboard-hero-grid">
          <div>
            {/* <p className="os-kicker">on-chain only</p> */}
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
            <span>routes: {showRoutes}</span>
          </div>
        </div>
      </section>

      <section className="metric-grid">
        <article className="os-card metric-card"><span>Routes</span><strong>{showRoutes}</strong><small>cross-chain history</small></article>
        <article className="os-card metric-card"><span>In Flight</span><strong>{showActive}</strong><small>pending or finalizing</small></article>
        <article className="os-card metric-card"><span>Confirmed</span><strong>{showSucceeded}</strong><small>receipt ready</small></article>
        <article className="os-card metric-card"><span>Needs Review</span><strong>{showFailed}</strong><small>failed route</small></article>
      </section>



      <TransactionTable title="Recent transactions" transactions={txs.slice(0, 5)} loading={loading} error={error} allowDisconnected={true} />
    </div>
  );
}

export function TransactionsView({ receiptsOnly = false }: { receiptsOnly?: boolean }) {
  const { data, loading, error, reload } = useTransactions(80, true);
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
            {/* <p className="os-kicker">live route history</p> */}
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
  const { config } = useDappConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const [lines, setLines] = useState<string[]>([
    "Chrysalis terminal ready.",
    "Type help to see commands. Type swap 5 USDC on Base to WETH to build a route."
  ]);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [thinkingText, setThinkingText] = useState("");
  const [thinkingTick, setThinkingTick] = useState(0);
  const [pendingRoute, setPendingRoute] = useState<{ intent: any; quote: any; analysis: any; explanation: string } | null>(null);

  const outputRef = useRef<HTMLPreElement>(null);
  const renderedLines = useMemo(() => {
    if (!thinkingText) return lines;
    const dots = ".".repeat((thinkingTick % 3) + 1);
    return [...lines, `thinking${dots} ${thinkingText}`];
  }, [lines, thinkingText, thinkingTick]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [renderedLines]);

  useEffect(() => {
    if (!thinkingText) return;
    const timer = setInterval(() => setThinkingTick((value) => value + 1), 450);
    return () => clearInterval(timer);
  }, [thinkingText]);

  const append = useCallback((next: string) => {
    setLines((prev) => [...prev, next]);
  }, []);

  async function fetchPath(label: string, path: string) {
    setRunning(true);
    setThinkingText(`fetching ${path}`);
    append(`$ ${label}`);
    try {
      const res = await fetch(`${API_URL}${path}`);
      const body = await res.text();
      append(formatTerminalBody(body).slice(0, 3200));
    } catch (err) {
      append(err instanceof Error ? err.message : String(err));
    } finally {
      setThinkingText("");
      setRunning(false);
    }
  }

  async function askAI(message: string, previousIntent?: any) {
    setRunning(true);
    setThinkingText("AIAssistant parsing route request");
    append(`$ ${message}`);
    try {
      const aiMessage = previousIntent
        ? `Update this pending route using the user's follow-up. Keep any fields the user did not change.\n\nPending route JSON:\n${JSON.stringify(previousIntent)}\n\nUser follow-up:\n${message}`
        : message;
      const res = await fetch(`${API_URL}/agents/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: aiMessage,
          connectedWallet: address,
          connectedChain: chainKeyFromId(chain?.id),
          solanaWallet: solanaAddress ?? undefined,
          stellarWallet: stellarAddress ?? undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? "AI agent failed");

      if (data.intent || data.quote) {
        setThinkingText("RiskPolicyAgent, FeeQuoteAgent, RoutePlannerAgent building plan");
        const mergedIntent = previousIntent ? mergeTerminalIntent(previousIntent, data.intent ?? {}) : data.intent ?? {};
        const terminalIntent = normalizeTerminalIntent(mergedIntent, {
          address,
          solanaAddress,
          stellarAddress,
          connectedChain: chainKeyFromId(chain?.id)
        });
        const validationError = validateTerminalIntent(terminalIntent);
        if (validationError) {
          append(`route rejected.\n\n${validationError}`);
          return;
        }
        const [analysisRes, quoteRes] = await Promise.all([
          fetch(`${API_URL}/agents/analyze`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(terminalIntent)
          }),
          fetch(`${API_URL}/quotes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...terminalIntent, quoteOnly: true })
          })
        ]);
        const analysis = await analysisRes.json();
        const liveQuote = await quoteRes.json();
        if (!analysisRes.ok) throw new Error(analysis?.error ?? "agent analysis failed");
        if (!quoteRes.ok) throw new Error(liveQuote?.error ?? "route quote failed");
        setThinkingText("");

        // Store the route for user confirmation
        setPendingRoute({
          intent: terminalIntent,
          quote: liveQuote,
          analysis,
          explanation: previousIntent
            ? data.explanation ?? "Follow-up applied to previous route."
            : data.explanation ?? "AI decoded your route."
        });

        let routePreview = `${previousIntent ? data.explanation ?? "Follow-up applied to previous route." : data.explanation ?? "Route decoded."}\n\n`;
        routePreview += "══════════════════════════════════════\n";
        routePreview += "  ROUTE PREVIEW\n";
        routePreview += "══════════════════════════════════════\n";

        if (terminalIntent) {
          const i = terminalIntent;
          if (i.sourceChain) routePreview += `  source:      ${CHAIN_LABEL[i.sourceChain] ?? i.sourceChain}\n`;
          if (i.destinationChain) routePreview += `  destination:  ${CHAIN_LABEL[i.destinationChain] ?? i.destinationChain}\n`;
          if (i.amount) routePreview += `  amount:       ${i.amount} ${i.asset ?? "USDC"}\n`;
          if (i.protocol) routePreview += `  protocol:     ${i.protocol}\n`;
          if (i.action) routePreview += `  action:       ${i.action}\n`;
          if (i.recipient) routePreview += `  recipient:    ${shortHash(i.recipient)}\n`;
          if (i.slippageBps !== undefined) routePreview += `  slippage:     ${i.slippageBps} bps\n`;
          if (i.optimizationGoal) routePreview += `  goal:         ${i.optimizationGoal}\n`;
          const metadataSummary = terminalMetadataSummary(i.metadata);
          if (metadataSummary) routePreview += `  metadata:     ${metadataSummary}\n`;
          const extras = Object.entries(i).filter(([k, v]) =>
            !["sourceChain","destinationChain","amount","asset","protocol","action","recipient","slippageBps","optimizationGoal","metadata","preferredRoute","maxTotalFeeUsd"].includes(k)
            && v !== undefined
            && v !== null
            && v !== ""
          );
          for (const [k, v] of extras) {
            routePreview += `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`;
          }
        }

        const selected = liveQuote.selected ?? liveQuote.plan?.feeQuote;
        const plan = analysis.plan ?? liveQuote.plan ?? {};
        const decision = plan.intentDecision ?? {};
        routePreview += "\n  route decision:\n";
        routePreview += `    preferred:   ${terminalIntent.preferredRoute ?? "auto"}\n`;
        routePreview += `    selected:    ${plan.routeKind ?? selected?.routeKind ?? decision.selectedRoute ?? "UNKNOWN"}\n`;
        routePreview += `    reason:      ${decision.reason ?? plan.rationale?.[0] ?? "No reason returned"}\n`;
        const extraRationale = Array.isArray(plan.rationale) ? plan.rationale.slice(1, 3) : [];
        for (const reason of extraRationale) routePreview += `    note:        ${reason}\n`;
        const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
        if (alternatives.length > 0) {
          routePreview += "    alternatives:\n";
          for (const alt of alternatives.slice(0, 3)) {
            const why = alt.eligible ? alt.reason : alt.rejectionReasons?.[0] ?? alt.reason;
            routePreview += `      - ${alt.routeKind}: ${alt.eligible ? "eligible" : "blocked"}${why ? ` - ${why}` : ""}\n`;
          }
        }
        if (selected) {
          routePreview += "\n  agent quote:\n";
          routePreview += `    route:       ${selected.routeKind} (${selected.circleProduct})\n`;
          routePreview += `    output:      ${selected.estimatedOutputAmount} ${selected.receiptTokenSymbol ?? selected.outputTokenSymbol}\n`;
          routePreview += `    user pays:   ${selected.userPaysUsd} USDC\n`;
          routePreview += `    est. time:   ${selected.estimatedTimeSeconds}s\n`;
        }

        routePreview += "\n  agent stack:\n";
        routePreview += "    1. AIAssistant           natural-language intent\n";
        routePreview += `    2. RiskPolicyAgent       ${analysis.policy?.allowed ? "allowed" : "blocked"}\n`;
        routePreview += "    3. FeeQuoteAgent         compared Gateway / CCTP / BridgeKit / Local\n";
        routePreview += `    4. RoutePlannerAgent     selected ${analysis.plan?.routeKind ?? "UNKNOWN"}\n`;
        routePreview += `    5. ProtocolActionAgent   built ${analysis.actionPayload?.executionMode ?? "protocol"} payload\n`;
        routePreview += "    6. JudgeNarratorAgent    records final receipt after execution\n";

        const blockReason = terminalRouteBlockReason({ quote: liveQuote, analysis });
        routePreview += "\n══════════════════════════════════════\n";
        if (blockReason) {
          routePreview += `  cannot execute yet: ${blockReason}\n`;
          routePreview += "  type a follow-up like \"use cctpv2\", \"to Base\", or \"swap to WETH\"\n";
        } else {
          routePreview += "  type \"execute\" to open wallet prompts and confirm\n";
          routePreview += "  type \"cancel\" to discard\n";
        }
        routePreview += "══════════════════════════════════════";

        append(routePreview.slice(0, 3600));
      } else {
        // No route — just show the explanation
        append(data.explanation ?? "No route decoded.");
      }
    } catch (err) {
      append(err instanceof Error ? err.message : String(err));
    } finally {
      setThinkingText("");
      setRunning(false);
    }
  }

  async function executePendingRoute(routeToExecute = pendingRoute) {
    if (!routeToExecute) {
      append("no pending route. type a swap/bridge command first.");
      return;
    }
    setRunning(true);
    setThinkingText("preparing user-controlled execution");
    append("$ execute\n\nuser-controlled execution starting...");
    try {
      const intent = routeToExecute.intent;
      const selected = routeToExecute.quote?.selected ?? routeToExecute.quote?.plan?.feeQuote ?? routeToExecute.analysis?.plan?.feeQuote;
      const routeKind = selected?.routeKind ?? routeToExecute.analysis?.plan?.routeKind ?? intent.preferredRoute;
      const blockReason = terminalRouteBlockReason(routeToExecute);
      if (blockReason) {
        append(`execution stopped before wallet prompts.\n\n${blockReason}\n\nType a follow-up like "use cctpv2", "use gateway", "to Base", or "swap to WETH" to replan.`);
        return;
      }
      const sourceChain = intent.sourceChain;
      const sourceChainId = CHAIN_KEY_TO_ID[sourceChain];
      const metadataPayload: Record<string, unknown> = {
        ...(intent.metadata ?? {}),
        sourceWalletAddress: address,
        evmReceiptWalletAddress: address,
        solanaAddress: solanaAddress ?? intent.metadata?.solanaAddress,
        stellarAddress: stellarAddress ?? intent.metadata?.stellarAddress
      };
      let paymentHeader: string | undefined;
      if (sourceChainId && sourceChain !== "SOLANA_DEVNET" && sourceChain !== "STELLAR_TESTNET" && routeKind !== "LOCAL") {
        paymentHeader = await requestX402PaymentHeader({
          ...intent,
          preferredRoute: routeKind,
          approved: true,
          metadata: metadataPayload
        });
      }

      if (sourceChainId && sourceChain !== "SOLANA_DEVNET" && sourceChain !== "STELLAR_TESTNET") {
        if (!address) throw new Error("connect EVM wallet first.");
        if (chain?.id !== sourceChainId) throw new Error(`switch wallet to ${CHAIN_LABEL[sourceChain] ?? sourceChain} first.`);
        const usdcAddress = USDC_ADDRESSES[sourceChainId];
        const operatorAddress = (config as any)?.operatorAddress as `0x${string}` | undefined;
        if (!usdcAddress) throw new Error(`USDC address missing for ${sourceChain}.`);
        if (routeKind !== "GATEWAY") {
          if (!operatorAddress) throw new Error("operatorAddress missing from API /config.");
          const transferAmount = parseUnits(String(selected?.sourceDepositRequiredUsd ?? intent.amount), 6);
          append(`wallet prompt: transfer ${formatUnits(transferAmount, 6)} USDC to protocol operator\nagent reason: ${routeKind} route uses operator/router funds for bridge + protocol execution; user signs source funding tx.`);
          setThinkingText("waiting for wallet signature: source USDC transfer");
          const userDepositTxHash = await writeContractAsync({
            address: usdcAddress,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [operatorAddress, transferAmount]
          });
          append(`tx submitted: User source transfer\nchain: ${sourceChain}\nhash: ${userDepositTxHash}`);
          setThinkingText("waiting for source transfer confirmation");
          if (publicClient) await publicClient.waitForTransactionReceipt({ hash: userDepositTxHash });
          append(`tx confirmed: User source transfer\nhash: ${userDepositTxHash}`);
          metadataPayload.userDepositTxHash = userDepositTxHash;
        }
      }

      const intentPayload = {
        ...intent,
        preferredRoute: routeKind,
        approved: true,
        metadata: metadataPayload
      };

      setThinkingText("submitting intent to orchestrator");
      let res = await fetch(`${API_URL}/intents`, {
        method: "POST",
        headers: paymentHeader
          ? { "content-type": "application/json", "Payment-Signature": paymentHeader }
          : { "content-type": "application/json" },
        body: JSON.stringify(intentPayload)
      });

      if (res.status === 402) {
        const fallbackPaymentHeader = await signX402PaymentFromResponse(res);
        setThinkingText("resubmitting intent with Payment-Signature");
        res = await fetch(`${API_URL}/intents`, {
          method: "POST",
          headers: { "content-type": "application/json", "Payment-Signature": fallbackPaymentHeader },
          body: JSON.stringify(intentPayload)
        });
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? "execution failed");
      setThinkingText("orchestrator accepted route");
      append(`route submitted.\n\nintent id: ${data.id ?? "unknown"}\nstatus: ${data.status ?? "pending"}\n\nstreaming route steps + tx hashes...`);
      await streamTerminalIntent(data.id);
      setPendingRoute(null);
    } catch (err) {
      append(`execution error: ${err instanceof Error ? err.message : String(err)}\n\nroute is still pending. type \"execute\" to retry or \"cancel\" to discard.`);
    } finally {
      setThinkingText("");
      setRunning(false);
    }
  }

  async function requestX402PaymentHeader(intentPayload: Record<string, unknown>) {
    setThinkingText("requesting x402 payment terms before source funding");
    const res = await fetch(`${API_URL}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(intentPayload)
    });
    if (res.status !== 402) {
      const body = await res.text();
      throw new Error(`Expected x402 payment challenge before source funding, got ${res.status}: ${body.slice(0, 240)}`);
    }
    return signX402PaymentFromResponse(res);
  }

  async function signX402PaymentFromResponse(res: Response) {
    append("wallet prompt: x402 relayer/API fee signature\nagent reason: paid API execution requires signed USDC authorization; no private key automation.");
    if (!address || !chain?.id) throw new Error("connect EVM wallet for x402 signature.");
    setThinkingText("loading x402 payment terms");
    const challengeHeader = res.headers.get("PAYMENT-REQUIRED");
    if (!challengeHeader) throw new Error("402 response missing PAYMENT-REQUIRED header.");
    const liveChallenge = decodeBase64Json(challengeHeader) as any;
    const requirement = liveChallenge.accepts?.find((item: any) => item.network === `eip155:${chain.id}`);
    if (!requirement) throw new Error(`x402 network eip155:${chain.id} not accepted.`);
    append(`x402 settlement target: ${requirement.payTo}\namount: ${formatUnits(BigInt(requirement.amount), 6)} USDC`);
    await ensureX402GatewayBalance(BigInt(requirement.amount));
    const typedData = buildGatewayPaymentAuth(address as `0x${string}`, requirement);
    setThinkingText("waiting for wallet signature: x402 relayer/API payment");
    const signature = await signTypedDataAsync({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message
    });
    return encodeBase64Json({
      x402Version: liveChallenge.x402Version,
      resource: liveChallenge.resource,
      accepted: requirement,
      payload: { authorization: typedData.authorization, signature }
    });
  }

  async function ensureX402GatewayBalance(amountRaw: bigint) {
    if (!address) throw new Error("connect EVM wallet for x402 payment.");
    const arcChainId = CHAIN_KEY_TO_ID.ARC;
    if (chain?.id !== arcChainId) {
      throw new Error("x402 is restricted to Arc. Switch wallet to Arc before signing x402 payment.");
    }

    const readGatewayBalance = async () => {
      const balanceRes = await fetch(`${API_URL}/gateway/balances/${address}`);
      const balanceData = balanceRes.ok ? await balanceRes.json() : { balances: [] };
      const existingRow = Array.isArray(balanceData?.balances)
        ? balanceData.balances.find((item: any) => item.chain === "ARC" && (item.asset === "USDC" || balanceData.token === "USDC"))
        : undefined;
      return parseUnits(String(existingRow?.amount ?? existingRow?.balance ?? "0"), 6);
    };

    setThinkingText("checking Circle Gateway balance for x402 payment");
    const existing = await readGatewayBalance();
    if (existing >= amountRaw) {
      append(`x402 Gateway balance ready: ${formatUnits(existing, 6)} USDC available`);
      return;
    }

    const topUp = amountRaw - existing;
    const sourceUsdc = USDC_ADDRESSES[arcChainId];
    if (!sourceUsdc) throw new Error("Arc USDC address missing for x402 top-up.");

    append(`wallet prompt: approve ${formatUnits(topUp, 6)} USDC x402 Gateway top-up`);
    setThinkingText("waiting for wallet signature: approve x402 top-up");
    const approveHash = await writeContractAsync({
      address: sourceUsdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ARC_GATEWAY_WALLET, topUp]
    });
    append(`tx submitted: x402 top-up approve\nchain: Arc\nhash: ${approveHash}`);
    setThinkingText("waiting for x402 top-up approve confirmation");
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approveHash });

    append(`wallet prompt: deposit ${formatUnits(topUp, 6)} USDC into Circle Gateway for x402`);
    setThinkingText("waiting for wallet signature: deposit x402 top-up");
    const depositHash = await writeContractAsync({
      address: ARC_GATEWAY_WALLET,
      abi: GATEWAY_WALLET_ABI,
      functionName: "deposit",
      args: [sourceUsdc, topUp]
    });
    append(`tx submitted: x402 Gateway top-up\nchain: Arc\nhash: ${depositHash}`);
    setThinkingText("waiting for x402 Gateway top-up confirmation");
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash: depositHash });
    append(`tx confirmed: x402 Gateway top-up\nhash: ${depositHash}`);

    const deadline = Date.now() + 90000;
    setThinkingText("waiting for Circle Gateway to index x402 balance");
    while (Date.now() < deadline) {
      const indexedBalance = await readGatewayBalance();
      if (indexedBalance >= amountRaw) {
        append(`x402 Gateway balance ready: ${formatUnits(indexedBalance, 6)} USDC available`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error("Gateway top-up tx confirmed, but Circle has not indexed the balance yet. Retry execute in a minute; no extra top-up needed.");
  }

  async function revisePendingRoute(message: string, executeAfter = false) {
    if (!pendingRoute) return false;
    const patch = terminalRoutePatch(message);
    if (!patch) return false;

    setRunning(true);
    setThinkingText("replanning previous route with follow-up");
    append(`$ ${message}\n\nupdating previous route...`);
    try {
      const updatedIntent = normalizeTerminalIntent(mergeTerminalIntent(pendingRoute.intent, patch), {
        address,
        solanaAddress,
        stellarAddress,
        connectedChain: chainKeyFromId(chain?.id)
      });
      const validationError = validateTerminalIntent(updatedIntent);
      if (validationError) throw new Error(validationError);
      const [analysisRes, quoteRes] = await Promise.all([
        fetch(`${API_URL}/agents/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(updatedIntent)
        }),
        fetch(`${API_URL}/quotes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...updatedIntent, quoteOnly: true })
        })
      ]);
      const analysis = await analysisRes.json();
      const liveQuote = await quoteRes.json();
      if (!analysisRes.ok) throw new Error(analysis?.error ?? "agent analysis failed");
      if (!quoteRes.ok) throw new Error(liveQuote?.error ?? "route quote failed");
      const updatedRoute = {
        intent: updatedIntent,
        quote: liveQuote,
        analysis,
        explanation: "Follow-up applied to previous route."
      };
      setPendingRoute(updatedRoute);

      const selected = liveQuote.selected ?? liveQuote.plan?.feeQuote;
      const plan = analysis.plan ?? liveQuote.plan ?? {};
      const blockReason = terminalRouteBlockReason(updatedRoute);
      append([
        "updated route preview",
        `source:    ${CHAIN_LABEL[updatedIntent.sourceChain] ?? updatedIntent.sourceChain}`,
        `dest:      ${CHAIN_LABEL[updatedIntent.destinationChain] ?? updatedIntent.destinationChain}`,
        `protocol:  ${updatedIntent.protocol}`,
        `amount:    ${updatedIntent.amount} ${updatedIntent.asset ?? "USDC"}`,
        `preferred: ${updatedIntent.preferredRoute ?? "auto"}`,
        `selected:  ${plan.routeKind ?? selected?.routeKind ?? "UNKNOWN"}`,
        `reason:    ${plan.intentDecision?.reason ?? plan.rationale?.[0] ?? "No reason returned"}`,
        selected ? `quote:     ${selected.estimatedOutputAmount} ${selected.receiptTokenSymbol ?? selected.outputTokenSymbol}, user pays ${selected.userPaysUsd} USDC` : "",
        blockReason ? `status:    cannot execute yet - ${blockReason}` : `status:    ready for execute`
      ].filter(Boolean).join("\n"));

      if (executeAfter) {
        await executePendingRoute(updatedRoute);
      }
      return true;
    } catch (err) {
      append(`follow-up error: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    } finally {
      setThinkingText("");
      setRunning(false);
    }
  }

  async function streamTerminalIntent(intentId: string) {
    if (!intentId) return;
    let lastStatus = "";
    const seen = new Set<string>();
    for (let i = 0; i < 240; i++) {
      setThinkingText(`polling intent ${intentId}`);
      const receiptRes = await fetch(`${API_URL}/intents/${intentId}`);
      const receipt = await receiptRes.json();
      if (receipt.status !== lastStatus) {
        lastStatus = receipt.status;
        append(`step: ${terminalStepForStatus(receipt.status, receipt)}`);
      }

      const statusRes = await fetch(`${API_URL}/transactions/${intentId}/status`);
      if (statusRes.ok) {
        const enriched = await statusRes.json();
        for (const tx of enriched.onChain?.transactions ?? []) {
          const key = `${tx.label}:${tx.hash}:${tx.status?.confirmed}`;
          if (seen.has(key)) continue;
          seen.add(key);
          append(`tx: ${tx.label}\nchain: ${CHAIN_LABEL[tx.chain] ?? tx.chain}\nhash: ${tx.hash}\nstatus: ${tx.status?.confirmed ? "confirmed" : tx.status?.found ? "found" : "pending"}`);
        }
      }

      if (["succeeded", "failed", "needs_approval"].includes(receipt.status)) {
        setThinkingText("");
        const outSymbol = receipt.protocolReceipt?.amountOutSymbol ?? receipt.protocolReceipt?.tokenOutSymbol ?? "";
        const outAmount = receipt.protocolReceipt?.amountOutFormatted;
        append(`final: ${receipt.status}${outAmount ? `\noutput: ${outAmount} ${outSymbol}` : ""}${receipt.nftReceipt?.tokenId ? `\nArc receipt NFT: #${receipt.nftReceipt.tokenId}` : ""}${receipt.error ? `\nerror: ${receipt.error}` : ""}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    setThinkingText("");
    append(`stream timeout: intent ${intentId} still running. type "transactions" for latest status.`);
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
        if (pendingRoute && terminalRoutePatch(arg)) {
          await revisePendingRoute(input, true);
          return;
        }
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
        if (!owners) {
          append(`$ ${input}\n\nconnect a wallet first, then run transactions again.`);
          return;
        }
        await fetchPath(input, `/transactions?limit=20&owner=${owners}`);
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
        if (pendingRoute && await revisePendingRoute(input)) {
          return;
        }
        if (pendingRoute && !["execute", "confirm", "cancel", "discard"].includes(name.toLowerCase())) {
          await askAI(input, pendingRoute.intent);
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
        <pre ref={outputRef} className="terminal-output">{renderedLines.join("\n\n")}</pre>
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

function TransactionTable({ title, transactions, loading, error, receiptsOnly, allowDisconnected = false }: {
  title?: string;
  transactions: TransactionResponse[];
  loading: boolean;
  error: string | null;
  receiptsOnly?: boolean;
  allowDisconnected?: boolean;
}) {
  const { isConnected } = useAccount();
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
      {!loading && !isConnected && !allowDisconnected && (
        <p className="empty-state">
          {receiptsOnly
            ? "Connect wallet to view your receipt NFTs."
            : "Connect wallet to view transaction history."}
        </p>
      )}
      {!loading && (isConnected || allowDisconnected) && transactions.length === 0 && <p className="empty-state">No on-chain transaction records found.</p>}
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
