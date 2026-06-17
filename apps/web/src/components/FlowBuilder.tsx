"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useReadContract, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, usePublicClient, useSignTypedData } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { ArcOsClient } from "@arc-os/sdk";
import type { AppConfig, ChainInfo, ProtocolInfo } from "@arc-os/sdk";
import { signTransaction as signFreighterTransaction } from "@stellar/freighter-api";
import { Asset, BASE_FEE, Contract as StellarContract, Address as StellarAddress, Horizon, Networks, Operation, TransactionBuilder, nativeToScVal, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { Connection as SolanaConnection, PublicKey as SolanaPublicKey, Transaction as SolanaTransaction, TransactionInstruction as SolanaTransactionInstruction } from "@solana/web3.js";
import {
  USDC_ADDRESSES, ROUTER_ADDRESSES, CHAIN_KEY_TO_ID, ERC20_ABI,
  arcTestnet
} from "../providers";
import { freighterErrorMessage, useWalletConnections } from "./WalletConnectionContext";

const GATEWAY_WALLET_ABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "value", type: "uint256" }], outputs: [] },
] as const;

const goals = ["balanced", "lowest_cost", "fastest", "safest"];
const routes = ["", "GATEWAY", "BRIDGEKIT", "CCTP_V2", "LOCAL"];

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const client = new ArcOsClient(API_URL);
const STELLAR_TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const STELLAR_TESTNET_RPC_URL = process.env.NEXT_PUBLIC_STELLAR_TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org";
const STELLAR_USDC_CODE = "USDC";
const STELLAR_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const STELLAR_USDC_ASSET = new Asset(STELLAR_USDC_CODE, STELLAR_USDC_ISSUER);
const STELLAR_USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SOLANA_DEVNET_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const SOLANA_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOLANA_TOKEN_PROGRAM_ID = new SolanaPublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = new SolanaPublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 + 100;
function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}
function buildGatewayPaymentAuth(from: `0x${string}`, requirement: any) {
  const chainId = Number(requirement.network.replace("eip155:", ""));
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
    domain: { name: "GatewayWalletBatched", version: "1", chainId, verifyingContract: requirement.extra.verifyingContract } as const,
    primaryType: "TransferWithAuthorization" as const,
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
    authorization
  };
}
function encodeBase64Json(payment: Record<string, unknown>) {
  const json = JSON.stringify(payment);
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    return window.btoa(json);
  }
  return btoa(json);
}
function decodeBase64Json<T = any>(value: string): T {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    return JSON.parse(window.atob(value)) as T;
  }
  return JSON.parse(atob(value)) as T;
}

type QuoteResult = Awaited<ReturnType<typeof client.quote>>;
type RuntimeAppConfig = AppConfig & {
  solanaOperatorAddress?: string;
  stellarOperatorAddress?: string;
};

type SolanaBrowserProvider = {
  publicKey?: { toString: () => string };
  signTransaction?: (transaction: SolanaTransaction) => Promise<SolanaTransaction>;
  signAndSendTransaction?: (transaction: SolanaTransaction) => Promise<{ signature: string } | string>;
};

function getSolanaBrowserProvider(): SolanaBrowserProvider | null {
  if (typeof window === "undefined") return null;
  const wallets = window as Window & Record<string, any>;
  return wallets.phantom?.solana ?? wallets.backpack?.solana ?? wallets.solflare ?? wallets.solana ?? null;
}

function solanaAta(mint: SolanaPublicKey, owner: SolanaPublicKey): SolanaPublicKey {
  return SolanaPublicKey.findProgramAddressSync(
    [owner.toBuffer(), SOLANA_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

function splTransferData(amountRaw: bigint): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amountRaw, 1);
  return data;
}

function formatError(err: unknown): string {
  if (!err) return "An unknown error occurred. Please try again.";
  let msg = err instanceof Error ? err.message : String(err);
  try {
    if (msg.includes("{") && msg.includes("}")) {
      const jsonStart = msg.indexOf("{");
      const jsonEnd = msg.lastIndexOf("}") + 1;
      const jsonStr = msg.slice(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonStr);
      if (parsed.error) return typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
      if (parsed.message) return parsed.message;
      if (parsed.details) return parsed.details;
      return "The request failed due to an unexpected response from the server.";
    }
  } catch {}
  if (msg.length > 200) {
    return "A system error occurred. Please check your inputs or try again later.";
  }
  return msg;
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


async function ensureStellarUsdcTrustline(stellarAddress: string): Promise<string | undefined> {
  const server = new Horizon.Server(STELLAR_TESTNET_HORIZON_URL);
  const account = await server.loadAccount(stellarAddress);
  const hasTrustline = account.balances.some((balance) =>
    "asset_code" in balance &&
    balance.asset_code === STELLAR_USDC_CODE &&
    balance.asset_issuer === STELLAR_USDC_ISSUER
  );

  if (hasTrustline) return undefined;

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: STELLAR_USDC_ASSET }))
    .setTimeout(300)
    .build();

  const signed = await signFreighterTransaction(tx.toXDR(), {
    networkPassphrase: Networks.TESTNET,
    address: stellarAddress,
  });
  if (signed.error) throw new Error(freighterErrorMessage(signed.error) ?? "Freighter rejected the USDC trustline transaction.");
  if (!signed.signedTxXdr) throw new Error("Freighter did not return a signed trustline transaction.");

  const signedTx = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET);
  const submitted = await server.submitTransaction(signedTx);
  return submitted.hash;
}

async function submitUserSolanaUsdcDeposit(input: {
  from: string;
  operator: string;
  amountRaw: bigint;
}): Promise<{ txHash: string; sourceTokenAccount: string; operatorTokenAccount: string }> {
  const provider = getSolanaBrowserProvider();
  if (!provider?.publicKey) throw new Error("Phantom is connected but the browser provider is unavailable.");
  if (provider.publicKey.toString() !== input.from) {
    throw new Error("Connected Phantom account changed. Reconnect the Solana wallet and try again.");
  }

  const connection = new SolanaConnection(SOLANA_DEVNET_RPC_URL, "confirmed");
  const owner = new SolanaPublicKey(input.from);
  const operator = new SolanaPublicKey(input.operator);
  const mint = new SolanaPublicKey(SOLANA_USDC_MINT);
  const sourceTokenAccount = solanaAta(mint, owner);
  const operatorTokenAccount = solanaAta(mint, operator);

  const sourceInfo = await connection.getAccountInfo(sourceTokenAccount, "confirmed");
  if (!sourceInfo) throw new Error(`Your Solana USDC token account is missing: ${sourceTokenAccount.toBase58()}.`);
  const operatorInfo = await connection.getAccountInfo(operatorTokenAccount, "confirmed");
  if (!operatorInfo) throw new Error(`Operator Solana USDC token account is missing: ${operatorTokenAccount.toBase58()}.`);
  const balance = await connection.getTokenAccountBalance(sourceTokenAccount, "confirmed");
  if (BigInt(balance.value.amount) < input.amountRaw) {
    throw new Error(`Insufficient Solana USDC. Need ${Number(input.amountRaw) / 1e6} USDC, have ${balance.value.uiAmountString ?? "0"}.`);
  }

  const tx = new SolanaTransaction().add(new SolanaTransactionInstruction({
    programId: SOLANA_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: operatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: splTransferData(input.amountRaw)
  }));
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;

  let txHash: string;
  if (provider.signAndSendTransaction) {
    const sent = await provider.signAndSendTransaction(tx);
    txHash = typeof sent === "string" ? sent : sent.signature;
  } else if (provider.signTransaction) {
    const signed = await provider.signTransaction(tx);
    txHash = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  } else {
    throw new Error("Connected Solana wallet does not support transaction signing.");
  }

  const confirmation = await connection.confirmTransaction({
    signature: txHash,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  }, "confirmed");
  if (confirmation.value.err) throw new Error(`Solana USDC deposit failed: ${JSON.stringify(confirmation.value.err)}`);

  return {
    txHash,
    sourceTokenAccount: sourceTokenAccount.toBase58(),
    operatorTokenAccount: operatorTokenAccount.toBase58()
  };
}

async function submitUserStellarUsdcDeposit(input: {
  from: string;
  operator: string;
  amountRaw: bigint;
}): Promise<string> {
  const server = new StellarRpc.Server(STELLAR_TESTNET_RPC_URL);
  const account = await server.getAccount(input.from);
  const usdc = new StellarContract(STELLAR_USDC_CONTRACT);
  let tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 200),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(usdc.call(
      "transfer",
      new StellarAddress(input.from).toScVal(),
      new StellarAddress(input.operator).toScVal(),
      nativeToScVal(input.amountRaw, { type: "i128" })
    ))
    .setTimeout(300)
    .build();

  tx = await server.prepareTransaction(tx);
  const signed = await signFreighterTransaction(tx.toXDR(), {
    networkPassphrase: Networks.TESTNET,
    address: input.from,
  });
  if (signed.error) throw new Error(freighterErrorMessage(signed.error) ?? "Freighter rejected the Stellar USDC transfer.");
  if (!signed.signedTxXdr) throw new Error("Freighter did not return a signed Stellar transfer.");

  const signedTx = TransactionBuilder.fromXDR(signed.signedTxXdr, Networks.TESTNET);
  const sent = await server.sendTransaction(signedTx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`Stellar USDC transfer failed to submit: ${sent.status} ${sent.errorResult ?? ""}`.trim());
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return sent.hash;
    if (result.status !== "NOT_FOUND") throw new Error(`Stellar USDC transfer failed: ${result.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for Stellar USDC transfer ${sent.hash}`);
}

// ── Known swap-to tokens per destination chain (for DEX tokenOut selector) ──
// Note: Uniswap V3 testnet liquidity is sparse — pools must exist for the pair.
const CHAIN_SWAP_TOKENS: Record<string, Array<{ symbol: string; address: string; note?: string }>> = {
  ARC: [],
  BASE_SEPOLIA: [
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", note: "Executable USDC -> WETH pools found on Base Sepolia Uniswap V3." }
  ],
  ETHEREUM_SEPOLIA: [
    { symbol: "WETH", address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", note: "Executable ERC-20 output for Ethereum Sepolia Uniswap V3 and Aave WETH flows." }
  ],
  SOLANA_DEVNET: [],
  STELLAR_TESTNET: [
    { symbol: "XLM", address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" }
  ]
};

const PROTOCOL_RECEIPT_TOKENS: Record<string, { symbol: string; detail: string }> = {
  ETH_AAVE_V3: { symbol: "aEthWETH", detail: "Aave receipt token for supplied WETH" },
  BASE_MORPHO_BLUE: { symbol: "Morpho USDC shares", detail: "Internal Morpho Blue market position" },
  SOL_KAMINO_LEND: { symbol: "Kamino USDC collateral", detail: "Kamino reserve collateral position" },
  SOL_MARINADE: { symbol: "mSOL", detail: "Marinade liquid staking token" },
  XLM_BLEND: { symbol: "Blend USDC position", detail: "Blend pool position for supplied USDC" }
};

function isPositionCreatingAction(action: string) {
  return ["supply", "supply_collateral", "deposit"].includes(String(action).toLowerCase());
}

function receiptTokenForProtocol(protocolKey?: string, action = "supply") {
  if (!protocolKey) return null;
  if (protocolKey === "SOL_MARINADE") return PROTOCOL_RECEIPT_TOKENS.SOL_MARINADE;
  if (!isPositionCreatingAction(action)) return null;
  return PROTOCOL_RECEIPT_TOKENS[protocolKey] ?? null;
}

function displayProtocolOutputSymbol(protocolKey: string | undefined, action: string, fallback: string | undefined) {
  return receiptTokenForProtocol(protocolKey, action)?.symbol ?? fallback ?? "";
}

function selectedSwapTokenSymbol(chain: string, value: string, customAddress?: string) {
  const actual = value === "custom" ? customAddress : value;
  const token = (CHAIN_SWAP_TOKENS[chain] ?? []).find((item) => item.address.toLowerCase() === String(actual ?? "").toLowerCase());
  if (token?.symbol) return token.symbol;
  if (actual === "0x0000000000000000000000000000000000000000") return chain === "ETHEREUM_SEPOLIA" || chain === "BASE_SEPOLIA" ? "ETH" : "Native";
  return value === "custom" && actual ? "Selected token" : undefined;
}

const FALLBACK_CHAINS: ChainInfo[] = [
  { key: "ARC",              name: "Arc Testnet",       vm: "evm",     hasGateway: true,  hasCctp: true,  hasPaymaster: true,  supportsNanopayments: true  },
  { key: "BASE_SEPOLIA",     name: "Base Sepolia",      vm: "evm",     hasGateway: true,  hasCctp: true,  hasPaymaster: true,  supportsNanopayments: true  },
  { key: "ETHEREUM_SEPOLIA", name: "Ethereum Sepolia",  vm: "evm",     hasGateway: true,  hasCctp: true,  hasPaymaster: true,  supportsNanopayments: true  },
  { key: "SOLANA_DEVNET",    name: "Solana Devnet",     vm: "svm",     hasGateway: false, hasCctp: true,  hasPaymaster: false, supportsNanopayments: false },
  { key: "STELLAR_TESTNET",  name: "Stellar Testnet",   vm: "soroban", hasGateway: false, hasCctp: true,  hasPaymaster: false, supportsNanopayments: false }
];

const FALLBACK_PROTOCOLS: Record<string, ProtocolInfo[]> = {
  ARC: [
    { key: "ARC_USDC_TRANSFER", name: "USDC Transfer",         type: "bridge_transfer", category: "bridge", actions: ["transfer"] },
    { key: "ARC_USYC_TELLER",   name: "USYC Teller",           type: "tokenized_cash",  category: "defi",   actions: [] }
  ],
  BASE_SEPOLIA: [
    { key: "BASE_USDC_TRANSFER", name: "USDC Transfer",        type: "bridge_transfer", category: "bridge", actions: ["transfer"] },
    { key: "BASE_UNISWAP_V3",  name: "Uniswap V3",           type: "dex",             category: "defi",   actions: [] },
    { key: "BASE_MORPHO_BLUE", name: "Morpho Blue",          type: "lending",         category: "defi",   actions: [] }
  ],
  ETHEREUM_SEPOLIA: [
    { key: "ETH_USDC_TRANSFER", name: "USDC Transfer",        type: "bridge_transfer", category: "bridge", actions: ["transfer"] },
    { key: "ETH_UNISWAP_V3",   name: "Uniswap V3",           type: "dex",             category: "defi",   actions: [] },
    { key: "ETH_AAVE_V3",      name: "Aave V3",              type: "lending",         category: "defi",   actions: [] }
  ],
  SOLANA_DEVNET: [
    { key: "SOL_USDC_TRANSFER", name: "USDC Transfer",        type: "bridge_transfer", category: "bridge", actions: ["transfer"] },
    { key: "SOL_MARINADE",      name: "Marinade Finance",    type: "liquid_staking",  category: "defi",   actions: ["supply"] }
  ],
  STELLAR_TESTNET: [
    { key: "XLM_USDC_TRANSFER", name: "USDC Transfer",        type: "bridge_transfer", category: "bridge", actions: ["transfer"] },
    { key: "XLM_AQUARIUS",     name: "Aquarius",             type: "dex",             category: "defi",   actions: [] },
    { key: "XLM_BLEND",        name: "Blend Capital",        type: "lending",         category: "defi",   actions: ["supply"] }
  ]
};

const PROTOCOL_TYPE_TO_ACTION: Record<string, string> = {
  dex: "swap", dex_clamm: "swap", dex_aggregator: "swap", fx: "swap",
  lending: "supply", tokenized_cash: "supply",
  liquid_staking: "supply",
  bridge_transfer: "transfer",
  unified_balance: "transfer", x402: "transfer"
};

const PROTOCOL_TYPE_ALLOWED_ACTIONS: Record<string, string[]> = {
  dex: ["swap"],
  dex_clamm: ["swap"],
  dex_aggregator: ["swap"],
  fx: ["swap"],
  lending: ["supply"],
  tokenized_cash: ["supply"],
  liquid_staking: ["supply"],
  bridge_transfer: ["transfer"],
  unified_balance: ["transfer"],
  x402: ["transfer"]
};

const ALL_ACTIONS = [
  { value: "supply",   label: "Supply / Lend" },
  { value: "supply_collateral",   label: "Supply Collateral" },
  { value: "withdraw", label: "Withdraw" },
  { value: "withdraw_collateral", label: "Withdraw Collateral" },
  { value: "borrow",   label: "Borrow" },
  { value: "repay",    label: "Repay" },
  { value: "swap",     label: "Swap Tokens" },
  { value: "transfer", label: "Bridge & Transfer" }
];

const CHAIN_SHORT: Record<string, string> = {
  ARC: "Arc Testnet", BASE_SEPOLIA: "Base Sepolia",
  ETHEREUM_SEPOLIA: "Ethereum Sepolia", SOLANA_DEVNET: "Solana Devnet", STELLAR_TESTNET: "Stellar Testnet"
};

const DISABLED_SOURCE_CHAIN_REASON: Record<string, string> = {};

const CHAIN_EXPLORER: Record<string, string> = {
  ARC: "https://testnet.arcscan.app",
  BASE_SEPOLIA: "https://sepolia.basescan.org",
  ETHEREUM_SEPOLIA: "https://sepolia.etherscan.io",
  SOLANA_DEVNET: "https://solscan.io",
  STELLAR_TESTNET: "https://stellar.expert/explorer/testnet"
};

const ROUTE_COLOR: Record<string, string> = {
  GATEWAY: "#10b981", CCTP_V2: "#3b82f6", BRIDGEKIT: "#8b5cf6", LOCAL: "#f59e0b", MOCK: "#6b7280"
};

const ROUTE_ESTIMATED_TIME_SECONDS: Record<string, number> = {
  GATEWAY: 10,
  CCTP_V2: 21,
  BRIDGEKIT: 32
};

function routeEstimatedTimeSeconds(routeKind: string, fallback = 30): number {
  return ROUTE_ESTIMATED_TIME_SECONDS[routeKind] ?? fallback;
}

function normalizeFeeQuoteEta<T extends { routeKind?: string; estimatedTimeSeconds?: number } | null | undefined>(feeQuote: T): T {
  if (!feeQuote?.routeKind) return feeQuote;
  return {
    ...feeQuote,
    estimatedTimeSeconds: routeEstimatedTimeSeconds(feeQuote.routeKind, feeQuote.estimatedTimeSeconds ?? 30)
  };
}

function isDexProtocol(type: string) {
  return ["dex", "dex_clamm", "dex_aggregator", "fx"].includes(type);
}
function isLendingProtocol(type: string) {
  return ["lending", "tokenized_cash", "liquid_staking"].includes(type);
}

function protocolInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function truncateAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function txExplorerUrl(chainKey: string, txHash: string) {
  const explorer = CHAIN_EXPLORER[chainKey] ?? CHAIN_EXPLORER.ARC;
  if (chainKey === "SOLANA_DEVNET") return `${explorer}/tx/${txHash}?cluster=devnet`;
  return `${explorer}/tx/${txHash}`;
}

function receiptTxHash(receipt: any): string | null {
  return (
    receipt?.protocolReceipt?.txHash ??
    receipt?.protocolReceipt?.stellarTxHash ??
    receipt?.protocolReceipt?.solanaTxHash ??
    receipt?.input?.metadata?.userDepositTxHash ??
    receipt?.bridgeReceipt?.txHash ??
    receipt?.bridgeReceipt?.burnTxHash ??
    receipt?.bridgeReceipt?.stellarTxHash ??
    receipt?.bridgeReceipt?.solanaTxHash ??
    receipt?.bridgeReceipt?.mintTxHash ??
    null
  );
}

function approvalRationale(receipt: any): string {
  const rationale = receipt?.plan?.rationale;
  return Array.isArray(rationale) && rationale.length > 0
    ? rationale.join(" ")
    : "Intent needs approval before execution.";
}

// ─────────────────────────────────────────────────────────────────────────────

export default function FlowBuilder() {
  const [config, setConfig] = useState<RuntimeAppConfig | null>(null);
  const [sourceChain, setSourceChain] = useState("ARC");
  const [destinationChain, setDestinationChain] = useState("BASE_SEPOLIA");
  const [protocol, setProtocol] = useState("BASE_UNISWAP_V3");
  const [amount, setAmount] = useState("1");
  const [action, setAction] = useState("supply");
  const [slippageBps, setSlippageBps] = useState("50");
  const [optimizationGoal, setOptimizationGoal] = useState("balanced");
  const [preferredRoute, setPreferredRoute] = useState("");
  const [maxTotalFeeUsd, setMaxTotalFeeUsd] = useState("5");

  // Protocol-specific params
  const [tokenOut, setTokenOut] = useState("");           // address for DEX swaps
  const [customTokenOut, setCustomTokenOut] = useState(""); // manual address entry

  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [loading, setLoading] = useState<"quote" | "approve" | "execute" | "signing_nanopayment" | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Metro tracker state ──────────────────────────────────
  type StepStatus = "pending" | "active" | "completed" | "failed";
  interface TrackerStep {
    label: string;
    tool: string;
    detail: string;
    status: StepStatus;
    links?: Array<{ label: string; value: string; href?: string }>;
  }
  const [executionPhase, setExecutionPhase] = useState<"idle" | "running" | "completed" | "failed">("idle");
  const [trackerSteps, setTrackerSteps] = useState<TrackerStep[]>([]);
  const [executionIntentId, setExecutionIntentId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [estimatedTotalSec, setEstimatedTotalSec] = useState(0);
  const [completedReceipt, setCompletedReceipt] = useState<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Wallet state from wagmi (EVM)
  const { address, isConnected, chain: connectedChain } = useAccount();

  // ── Non-EVM wallet state ─────────────────────────────────
  const {
    solanaAddress,
    solanaConnecting,
    connectSolanaWallet,
    disconnectSolanaWallet,
    stellarAddress,
    stellarConnecting,
    connectStellarWallet,
    disconnectStellarWallet,
    lastWalletError,
  } = useWalletConnections();
  const [solanaBalances, setSolanaBalances] = useState<{ sol: number; usdc: number } | null>(null);
  const [stellarBalances, setStellarBalances] = useState<{ xlm: number; usdc: number } | null>(null);
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const chains: ChainInfo[] = config?.chains ?? FALLBACK_CHAINS;
  const sourceChainInfo = chains.find((c) => c.key === sourceChain);
  const sourceVm = sourceChainInfo?.vm;
  const destChainInfo = chains.find((c) => c.key === destinationChain);
  const destVm = destChainInfo?.vm;
  const sourceWalletAddress = sourceVm === "svm"
    ? solanaAddress ?? undefined
    : sourceVm === "soroban"
      ? stellarAddress ?? undefined
      : address ?? undefined;

  // Source chain ID for this intent
  const sourceChainId = CHAIN_KEY_TO_ID[sourceChain];
  const usdcAddress = sourceChainId ? USDC_ADDRESSES[sourceChainId] : undefined;
  const routerAddress = sourceChainId ? ROUTER_ADDRESSES[sourceChainId] : undefined;

  // Read USDC balance of connected wallet on source chain
  const { data: rawBalance, refetch: refetchBalance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && usdcAddress) }
  });

  const usdcBalance = rawBalance !== undefined
    ? parseFloat(formatUnits(rawBalance as bigint, 6)).toFixed(2)
    : null;

  // Read USDC allowance for router
  const { data: rawAllowance, refetch: refetchAllowance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address && routerAddress ? [address, routerAddress] : undefined,
    query: { enabled: Boolean(address && usdcAddress && routerAddress) }
  });

  const allowanceAmount = rawAllowance !== undefined
    ? parseFloat(formatUnits(rawAllowance as bigint, 6))
    : 0;

  const amountNumber = parseFloat(amount) || 0;
  const selectedQuote = useMemo(() => {
    if (!quote?.selected) return null;
    const preferredAlternative = preferredRoute
      ? quote.alternatives?.find((alt: any) => alt.eligible && alt.routeKind === preferredRoute)
      : undefined;
    return normalizeFeeQuoteEta(preferredAlternative?.feeQuote ?? quote.selected);
  }, [quote, preferredRoute]);
  const selectedSourceDepositRequired = selectedQuote?.sourceDepositRequiredUsd ?? amount;
  const sourceDepositRequiredNumber = parseFloat(selectedSourceDepositRequired) || amountNumber;
  const needsApproval = sourceVm === "evm" && isConnected && selectedQuote?.routeKind !== "GATEWAY" && routerAddress && allowanceAmount < sourceDepositRequiredNumber;

  // Approve USDC
  const { writeContract: approveUsdc, data: approveTxHash, writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });

  // Wait for tx confirmation
  const { isLoading: txConfirming, isSuccess: txSuccess } = useWaitForTransactionReceipt({
    hash: txHash?.startsWith("0x") ? txHash as `0x${string}` : undefined,
    chainId: CHAIN_KEY_TO_ID[destinationChain]
  });

  useEffect(() => {
    if (!approveSuccess) return;
    refetchBalance();
    refetchAllowance();
    setLoading(null);
  }, [approveSuccess, refetchAllowance, refetchBalance]);

  useEffect(() => {
    if (!approveTxHash) return;
    refetchAllowance();
  }, [approveTxHash, refetchAllowance]);

  // Config
  useEffect(() => {
    client.getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  // Fetch and auto-refresh Solana/Stellar balances
  useEffect(() => {
    if (!solanaAddress) {
      setSolanaBalances(null);
      return;
    }
    const addr = solanaAddress as string;
    let active = true;
    async function update() {
      const bals = await getSolanaBalances(addr);
      if (active) setSolanaBalances(bals);
    }
    update();
    const interval = setInterval(update, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [solanaAddress]);

  useEffect(() => {
    if (!stellarAddress) {
      setStellarBalances(null);
      return;
    }
    const addr = stellarAddress as string;
    let active = true;
    async function update() {
      const bals = await getStellarBalances(addr);
      if (active) setStellarBalances(bals);
    }
    update();
    const interval = setInterval(update, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [stellarAddress]);

  useEffect(() => {
    if (lastWalletError) setError(lastWalletError);
  }, [lastWalletError]);

  useEffect(() => {
    if (!DISABLED_SOURCE_CHAIN_REASON[sourceChain]) return;
    const fallback = chains.find((chain) => !DISABLED_SOURCE_CHAIN_REASON[chain.key])?.key ?? "ARC";
    setSourceChain(fallback);
    setError(`${CHAIN_SHORT[sourceChain] ?? sourceChain} cannot be used as a source yet. ${DISABLED_SOURCE_CHAIN_REASON[sourceChain]}.`);
  }, [sourceChain, chains]);

  const protocolsForDestination: ProtocolInfo[] = useMemo(
    () => config?.protocolsByChain?.[destinationChain] ?? FALLBACK_PROTOCOLS[destinationChain] ?? [],
    [config, destinationChain]
  );

  const selectedProtocolInfo = useMemo(
    () => protocolsForDestination.find((p) => p.key === protocol) ?? null,
    [protocolsForDestination, protocol]
  );

  const allowedActions = useMemo(() => {
    const type = selectedProtocolInfo?.type ?? "";
    const allowed = PROTOCOL_TYPE_ALLOWED_ACTIONS[type];
    return allowed ? ALL_ACTIONS.filter((a) => allowed.includes(a.value)) : ALL_ACTIONS;
  }, [selectedProtocolInfo]);

  useEffect(() => {
    if (!config) return;
    if (protocolsForDestination.length === 0) { setProtocol(""); return; }
    if (!protocolsForDestination.some((p) => p.key === protocol)) setProtocol(protocolsForDestination[0].key);
  }, [config, destinationChain, protocolsForDestination]); // eslint-disable-line

  useEffect(() => {
    if (!selectedProtocolInfo) return;
    const def = PROTOCOL_TYPE_TO_ACTION[selectedProtocolInfo.type];
    if (def && !allowedActions.some((a) => a.value === action)) setAction(def);
  }, [selectedProtocolInfo]); // eslint-disable-line

  // Auto-set tokenOut when protocol/chain changes for DEX
  useEffect(() => {
    if (!selectedProtocolInfo) return;
    if (isDexProtocol(selectedProtocolInfo.type)) {
      const tokens = CHAIN_SWAP_TOKENS[destinationChain] ?? [];
      setTokenOut(tokens.length > 0 ? tokens[0].address : "");
      setCustomTokenOut("");
    }
  }, [selectedProtocolInfo, destinationChain]);

  // Build protocol-specific metadata
  const metadata = useMemo<Record<string, unknown> | undefined>(() => {
    if (!selectedProtocolInfo) return undefined;
    const type = selectedProtocolInfo.type;
    const meta: Record<string, unknown> = {};
    if (sourceWalletAddress) meta.sourceWalletAddress = sourceWalletAddress;
    if (address && address !== sourceWalletAddress) meta.evmReceiptWalletAddress = address;
    if (solanaAddress) meta.solanaAddress = solanaAddress;
    if (stellarAddress) meta.stellarAddress = stellarAddress;
    if (isDexProtocol(type) && action === "swap") {
      const actualTokenOut = tokenOut === "custom" ? customTokenOut : tokenOut;
      if (actualTokenOut) meta.tokenOut = actualTokenOut;
      const tokenOutSymbol = selectedSwapTokenSymbol(destinationChain, tokenOut, customTokenOut);
      if (tokenOutSymbol) meta.tokenOutSymbol = tokenOutSymbol;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
  }, [selectedProtocolInfo, action, tokenOut, customTokenOut, destinationChain, sourceWalletAddress, address, solanaAddress, stellarAddress]);

  const recipient = useMemo(() => {
    const vm = destVm;
    if (vm === "svm") return solanaAddress ?? undefined;
    if (vm === "soroban") return stellarAddress ?? undefined;
    return address ?? undefined;
  }, [destVm, solanaAddress, stellarAddress, address]);

  const request = useMemo(() => ({
    sourceChain: sourceChain as any,
    destinationChain: destinationChain as any,
    asset: "USDC" as const,
    amount,
    protocol,
    action,
    autonomous: true,
    recipient,
    slippageBps: Number(slippageBps),
    optimizationGoal: optimizationGoal as any,
    preferredRoute: preferredRoute ? preferredRoute as any : undefined,
    maxTotalFeeUsd: maxTotalFeeUsd || undefined,
    metadata
  }), [sourceChain, destinationChain, amount, protocol, action, recipient, slippageBps, optimizationGoal, preferredRoute, maxTotalFeeUsd, metadata]);
  const quoteRequestKey = useMemo(() => JSON.stringify(request), [request]);
  const lastAutoQuoteKeyRef = useRef("");

  async function loadRoutes(clearExisting = true) {
    if (!protocol) return setError(`No protocol available on ${destinationChain}.`);
    setLoading("quote"); setError(null); setTxHash(null);
    if (clearExisting) setQuote(null);
    resetTracker();
    try {
      const response = await client.quote(request);
      setQuote(response);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(null);
    }
  }

  async function getRoutes(e?: FormEvent) {
    e?.preventDefault();
    await loadRoutes(true);
  }

  useEffect(() => {
    if (!protocol || amountNumber <= 0 || executionPhase !== "idle") return;
    if (loading === "execute" || loading === "approve" || loading === "signing_nanopayment") return;
    const timeout = setTimeout(() => {
      if (lastAutoQuoteKeyRef.current === quoteRequestKey) return;
      lastAutoQuoteKeyRef.current = quoteRequestKey;
      void loadRoutes(false);
    }, 650);
    return () => clearTimeout(timeout);
  }, [quoteRequestKey, protocol, amountNumber, executionPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!protocol || amountNumber <= 0 || executionPhase !== "idle") return;
    const interval = setInterval(() => {
      if (loading === null || loading === "quote") void loadRoutes(false);
    }, 60_000);
    return () => clearInterval(interval);
  }, [quoteRequestKey, protocol, amountNumber, executionPhase, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApprove() {
    if (!usdcAddress || !routerAddress || !address) return;
    setLoading("approve"); setError(null);
    try {
      approveUsdc({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [routerAddress, parseUnits(selectedSourceDepositRequired, 6)]
      });
    } catch (err) {
      setError(formatError(err));
      setLoading(null);
    }
  }

  // ── Map backend intent status → step indices ────────────────
  const statusToStepIndex = useCallback((status: string): number => {
    switch (status) {
      case "created": return 0;
      case "planned": return 1;
      case "bridging": return 2;
      case "executing": return 3;
      case "finalizing": return 4;
      case "succeeded": return 5; // all done
      case "failed": return -1;
      default: return 0;
    }
  }, []);

  const updateStepsFromStatus = useCallback((steps: TrackerStep[], intentStatus: string): TrackerStep[] => {
    const activeIdx = statusToStepIndex(intentStatus);
    if (activeIdx === -1) {
      // Failed — mark current active as failed, rest stay as-is
      return steps.map(s => s.status === "active" ? { ...s, status: "failed" as StepStatus } : s);
    }
    return steps.map((s, i) => {
      if (i < activeIdx) return { ...s, status: "completed" as StepStatus };
      if (i === activeIdx) return { ...s, status: "active" as StepStatus };
      return { ...s, status: "pending" as StepStatus };
    });
  }, [statusToStepIndex]);

  const decorateStepsWithReceipt = useCallback((steps: TrackerStep[], receipt: any): TrackerStep[] => {
    const metadata = receipt?.input?.metadata ?? {};
    const bridge = receipt?.bridgeReceipt ?? {};
    const protocol = receipt?.protocolReceipt ?? {};
    const nft = receipt?.nftReceipt ?? {};
    const bridgeLinks = [
      metadata.gatewayApproveTxHash ? { label: "Approve", value: metadata.gatewayApproveTxHash, href: txExplorerUrl(sourceChain, metadata.gatewayApproveTxHash) } : null,
      metadata.gatewayDepositTxHash ? { label: "Gateway deposit", value: metadata.gatewayDepositTxHash, href: txExplorerUrl(sourceChain, metadata.gatewayDepositTxHash) } : null,
      metadata.userDepositTxHash ? { label: "User USDC deposit", value: metadata.userDepositTxHash, href: txExplorerUrl(sourceChain, metadata.userDepositTxHash) } : null,
      bridge.depositTxHash ? { label: "Source deposit", value: bridge.depositTxHash, href: txExplorerUrl(sourceChain, bridge.depositTxHash) } : null,
      bridge.burnTxHash ? { label: "CCTP burn", value: bridge.burnTxHash, href: txExplorerUrl(sourceChain, bridge.burnTxHash) } : null,
      bridge.txHash ? { label: "Bridge tx", value: bridge.txHash, href: txExplorerUrl(sourceChain, bridge.txHash) } : null,
      bridge.mintTxHash ? { label: "CCTP mint", value: bridge.mintTxHash, href: txExplorerUrl(destinationChain, bridge.mintTxHash) } : null,
      bridge.solanaTxHash ? { label: "Solana receive", value: bridge.solanaTxHash, href: txExplorerUrl("SOLANA_DEVNET", bridge.solanaTxHash) } : null,
      bridge.stellarTxHash ? { label: "Stellar receive", value: bridge.stellarTxHash, href: txExplorerUrl("STELLAR_TESTNET", bridge.stellarTxHash) } : null,
      bridge.transferId ? { label: "Gateway transfer", value: bridge.transferId } : null
    ].filter(Boolean).filter((link: any, index: number, links: any[]) =>
      links.findIndex((candidate: any) => candidate.value === link.value && candidate.label === link.label) === index
    ) as TrackerStep["links"];
    const protocolExecutionHash = protocol.txHash ?? protocol.stellarTxHash ?? protocol.solanaTxHash;
    const protocolLinks = protocolExecutionHash
      ? [{ label: "Execution", value: protocolExecutionHash, href: txExplorerUrl(destinationChain, protocolExecutionHash) }]
      : undefined;
    const nftLinks = nft.mintTxHash ? [{ label: "NFT mint", value: nft.mintTxHash, href: txExplorerUrl("ARC", nft.mintTxHash) }] : undefined;
    const protocolOutputSymbol = displayProtocolOutputSymbol(
      receipt?.input?.protocol ?? receipt?.plan?.protocol,
      receipt?.input?.action ?? action,
      protocol.amountOutSymbol ?? protocol.tokenOutSymbol
    );
    const executionDetail = protocol.amountOutFormatted
      ? `${protocol.executedAmountUsdc ?? receipt?.plan?.executionAmount ?? amount} ${protocol.tokenInSymbol ?? "USDC"} → ${protocol.amountOutFormatted} ${protocolOutputSymbol}`.trim()
      : protocol.note
        ? formatError(protocol.note)
      : steps[3]?.detail;
    const bridgeDetail = bridge.destinationRouterAmountReceivedUsdc
      ? `${CHAIN_SHORT[sourceChain] ?? sourceChain} → ${CHAIN_SHORT[destinationChain] ?? destinationChain} · received ${bridge.destinationRouterAmountReceivedUsdc} USDC`
      : bridge.note
        ? formatError(bridge.note)
      : steps[2]?.detail;

    return steps.map((step, index) => {
      if (index === 2) {
        return { ...step, detail: bridgeDetail, links: bridgeLinks?.length ? bridgeLinks : step.links };
      }
      if (index === 3) return { ...step, detail: executionDetail, links: protocolLinks ?? step.links };
      if (index === 4) return { ...step, links: nftLinks ?? step.links };
      return step;
    });
  }, [amount, destinationChain, sourceChain]);

  // ── Stop polling & timer ────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  // Clean up on unmount
  useEffect(() => stopPolling, [stopPolling]);

  async function handleExecute() {
    if (!selectedQuote) return setError("Get routes first to see a valid quote.");
    if (sourceVm === "evm" && (!isConnected || !address)) return setError("Please connect your EVM wallet with RainbowKit for the selected source chain.");
    if (sourceVm === "svm" && !solanaAddress) return setError("Please connect Phantom for the selected Solana source chain.");
    if (sourceVm === "soroban" && !stellarAddress) return setError("Please connect Freighter for the selected Stellar source chain.");
    if (destVm === "svm" && !solanaAddress) return setError("Please connect your Solana wallet for receiving on Solana.");
    if (destVm === "soroban" && !stellarAddress) return setError("Please connect your Stellar wallet for receiving on Stellar.");
    if (sourceVm === "evm" && !config?.operatorAddress) return setError("System config not loaded: missing operatorAddress.");
    if (sourceVm === "svm" && !config?.solanaOperatorAddress) return setError("System config not loaded: missing solanaOperatorAddress.");
    if (sourceVm === "soroban" && !config?.stellarOperatorAddress) return setError("System config not loaded: missing stellarOperatorAddress.");
    if (sourceVm === "evm" && !usdcAddress) return setError("USDC address not resolved for the source chain.");

    const sourceChainId = CHAIN_KEY_TO_ID[sourceChain];
    const connectedChainId = connectedChain?.id;
    if (sourceVm === "evm" && connectedChainId !== sourceChainId) {
      return setError(`Please switch your wallet network to ${CHAIN_SHORT[sourceChain] ?? sourceChain} first.`);
    }

    setLoading("execute");
    setError(null);

    try {
      const routeKind = selectedQuote.routeKind;
      
      // Calculate total amount needed on source chain
      const transferAmount = parseUnits(selectedQuote.sourceDepositRequiredUsd ?? amount, 6);
      // x402 relayer fee (0.05 USDC) for all non-LOCAL routes on EVM chains with Gateway
      const X402_FEE_USDC = 50000n;
      const needsX402Fee = routeKind !== "LOCAL" && sourceChain !== "SOLANA_DEVNET" && sourceChain !== "STELLAR_TESTNET";
      let totalAmountNeeded = transferAmount + (needsX402Fee ? X402_FEE_USDC : 0n);
      let metadataPayload: Record<string, unknown> = {
        ...(request.metadata || {}),
        sourceWalletAddress,
      };
      const evmOperatorAddress = config?.operatorAddress;
      const solanaOperatorAddress = config?.solanaOperatorAddress;
      const stellarOperatorAddress = config?.stellarOperatorAddress;

      if (destVm === "soroban" && stellarAddress) {
        console.log("[FlowBuilder] Checking Stellar USDC trustline before bridge...");
        try {
          const trustlineTxHash = await ensureStellarUsdcTrustline(stellarAddress);
          if (trustlineTxHash) {
            console.log(`[FlowBuilder] Stellar USDC trustline created: ${trustlineTxHash}`);
            metadataPayload = { ...metadataPayload, stellarUsdcTrustlineTxHash: trustlineTxHash };
          } else {
            console.log("[FlowBuilder] Stellar USDC trustline already exists.");
          }
        } catch (trustlineErr) {
          const message = trustlineErr instanceof Error ? trustlineErr.message : String(trustlineErr);
          setLoading(null);
          return setError(`Stellar USDC trustline is required before bridging. ${message}`);
        }
      }

      let balanceToUse = rawBalance as bigint | undefined;
      if (sourceVm === "evm") {
        // Refetch balance to get the most up-to-date balance
        console.log("[FlowBuilder] Fetching latest USDC balance...");
        const balanceResult = await refetchBalance();
        const currentBalance = balanceResult.data as bigint | undefined;
        balanceToUse = currentBalance !== undefined ? currentBalance : rawBalance as bigint | undefined;

        // Check user's USDC balance on source chain
        if (balanceToUse === undefined || balanceToUse < totalAmountNeeded) {
          const neededStr = (Number(totalAmountNeeded) / 1e6).toFixed(6);
          const currentStr = balanceToUse !== undefined ? (Number(balanceToUse) / 1e6).toFixed(6) : "0";
          setLoading(null);
          return setError(`Insufficient USDC balance on source chain. You need ${neededStr} USDC (transfer amount + fees), but you only have ${currentStr} USDC.`);
        }
      }

      if (routeKind === "GATEWAY") {
        if (sourceVm !== "evm" || !address) {
          setLoading(null);
          return setError("Gateway routes require an EVM source wallet. Choose an EVM source chain or another route.");
        }
        console.log("[FlowBuilder] Preparing user-signed Gateway BurnIntent...");
        const gatewayPrepared = await client.prepareGateway({
          ...request,
          preferredRoute: "GATEWAY" as any
        });
        totalAmountNeeded = BigInt(gatewayPrepared.depositAmount);

        const gatewayBalance = await client.getGatewayBalance(address!);
        const existingGatewayBalanceRow = gatewayBalance.balances?.find((balance) =>
          balance.chain === sourceChain &&
          (balance.asset === "USDC" || gatewayBalance.token === "USDC")
        );
        const existingGatewayBalance = parseUnits(String(existingGatewayBalanceRow?.amount ?? existingGatewayBalanceRow?.balance ?? "0"), 6);
        const gatewayDepositDelta = totalAmountNeeded > existingGatewayBalance ? totalAmountNeeded - existingGatewayBalance : 0n;

        if (balanceToUse === undefined || (balanceToUse as bigint) < gatewayDepositDelta) {
          const neededStr = (Number(gatewayDepositDelta) / 1e6).toFixed(6);
          const currentStr = balanceToUse !== undefined ? (Number(balanceToUse) / 1e6).toFixed(6) : "0";
          const indexedStr = (Number(existingGatewayBalance) / 1e6).toFixed(6);
          setLoading(null);
          return setError(`Insufficient USDC balance on source chain. Gateway needs ${neededStr} more USDC after using your indexed Gateway balance (${indexedStr} USDC), but you only have ${currentStr} USDC.`);
        }

        let gatewayApproveTxHash: `0x${string}` | undefined;
        let gatewayDepositTxHash: `0x${string}` | undefined;
        if (gatewayDepositDelta > 0n) {
          console.log(`[FlowBuilder] Approving GatewayWallet (${gatewayPrepared.gatewayWallet}) for ${Number(gatewayDepositDelta) / 1e6} USDC top-up...`);
          gatewayApproveTxHash = await writeContractAsync({
            address: gatewayPrepared.sourceUsdc,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [gatewayPrepared.gatewayWallet, gatewayDepositDelta]
          });
          if (publicClient) await publicClient.waitForTransactionReceipt({ hash: gatewayApproveTxHash });

          console.log(`[FlowBuilder] Depositing ${Number(gatewayDepositDelta) / 1e6} USDC top-up into GatewayWallet...`);
          gatewayDepositTxHash = await writeContractAsync({
            address: gatewayPrepared.gatewayWallet,
            abi: GATEWAY_WALLET_ABI,
            functionName: "deposit",
            args: [gatewayPrepared.sourceUsdc, gatewayDepositDelta]
          });
          if (publicClient) await publicClient.waitForTransactionReceipt({ hash: gatewayDepositTxHash });
        } else {
          console.log(`[FlowBuilder] Existing Gateway balance covers this intent; skipping Gateway deposit.`);
        }

        console.log("[FlowBuilder] Requesting user signature for Gateway BurnIntent...");
        const gatewaySignature = await signTypedDataAsync(gatewayPrepared.typedData as any);
        metadataPayload = {
          ...metadataPayload,
          gatewayApproveTxHash,
          gatewayDepositTxHash,
          gatewayExistingBalance: existingGatewayBalance.toString(),
          gatewayDepositDelta: gatewayDepositDelta.toString(),
          gatewayBurnIntent: gatewayPrepared.burnIntent,
          gatewaySignature,
          gatewayDepositor: address,
          gatewayMintRecipient: gatewayPrepared.mintRecipient
        };
      } else {
        let gatewayApproveTxHash: `0x${string}` | undefined;
        let gatewayDepositTxHash: `0x${string}` | undefined;
        let userTxHash: string | undefined;

        if (sourceVm === "evm") {
          console.log(`[FlowBuilder] Requesting transfer of ${Number(transferAmount) / 1e6} USDC to Operator (${evmOperatorAddress})...`);
          userTxHash = await writeContractAsync({
            address: usdcAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [evmOperatorAddress as `0x${string}`, transferAmount]
          });

          console.log(`[FlowBuilder] Transfer transaction submitted: ${userTxHash}. Waiting for confirmation...`);
          if (publicClient) {
            await publicClient.waitForTransactionReceipt({ hash: userTxHash as `0x${string}` });
            console.log(`[FlowBuilder] Transfer transaction confirmed!`);
          } else {
            await new Promise(r => setTimeout(r, 5000));
          }

          // Deposit x402 relayer fee into Gateway wallet on source chain
          if (needsX402Fee) {
            console.log(`[FlowBuilder] Checking Gateway balance for x402 fee deposit...`);
            const gatewayBalance = await client.getGatewayBalance(address!);
            const existingRow = gatewayBalance.balances?.find((b: any) =>
              b.chain === sourceChain && (b.asset === "USDC" || gatewayBalance.token === "USDC")
            );
            const existingGatewayBalance = parseUnits(String(existingRow?.amount ?? existingRow?.balance ?? "0"), 6);
            const feeDeposit = X402_FEE_USDC > existingGatewayBalance ? X402_FEE_USDC - existingGatewayBalance : 0n;

            if (feeDeposit > 0n) {
              const gatewayWallet = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
              const sourceUsdc = usdcAddress as `0x${string}`;

              console.log(`[FlowBuilder] Approving GatewayWallet (${gatewayWallet}) for ${Number(feeDeposit) / 1e6} USDC x402 fee...`);
              gatewayApproveTxHash = await writeContractAsync({
                address: sourceUsdc,
                abi: ERC20_ABI,
                functionName: "approve",
                args: [gatewayWallet, feeDeposit]
              });
              if (publicClient) await publicClient.waitForTransactionReceipt({ hash: gatewayApproveTxHash });

              console.log(`[FlowBuilder] Depositing ${Number(feeDeposit) / 1e6} USDC x402 fee into GatewayWallet...`);
              gatewayDepositTxHash = await writeContractAsync({
                address: gatewayWallet,
                abi: GATEWAY_WALLET_ABI,
                functionName: "deposit",
                args: [sourceUsdc, feeDeposit]
              });
              if (publicClient) await publicClient.waitForTransactionReceipt({ hash: gatewayDepositTxHash });
            } else {
              console.log(`[FlowBuilder] Existing Gateway balance (${Number(existingGatewayBalance) / 1e6} USDC) covers x402 fee; skipping deposit.`);
            }
          }
        } else if (sourceVm === "svm") {
          console.log(`[FlowBuilder] Requesting Phantom transfer of ${Number(transferAmount) / 1e6} USDC to Solana operator (${solanaOperatorAddress})...`);
          const solanaDeposit = await submitUserSolanaUsdcDeposit({
            from: solanaAddress!,
            operator: solanaOperatorAddress!,
            amountRaw: transferAmount
          });
          userTxHash = solanaDeposit.txHash;
          metadataPayload = {
            ...metadataPayload,
            solanaSourceUsdcAccount: solanaDeposit.sourceTokenAccount,
            solanaOperatorUsdcAccount: solanaDeposit.operatorTokenAccount
          };
          console.log(`[FlowBuilder] Solana USDC deposit confirmed: ${solanaDeposit.txHash}`);
        } else if (sourceVm === "soroban") {
          const stellarAmountRaw = parseUnits(selectedQuote.sourceDepositRequiredUsd ?? amount, 7);
          console.log(`[FlowBuilder] Requesting Freighter transfer of ${Number(stellarAmountRaw) / 1e7} USDC to Stellar operator (${stellarOperatorAddress})...`);
          const stellarDepositTxHash = await submitUserStellarUsdcDeposit({
            from: stellarAddress!,
            operator: stellarOperatorAddress!,
            amountRaw: stellarAmountRaw
          });
          userTxHash = stellarDepositTxHash;
          console.log(`[FlowBuilder] Stellar USDC deposit confirmed: ${stellarDepositTxHash}`);
        } else {
          console.log(`[FlowBuilder] ${sourceChain} source uses ${sourceVm}; no source deposit handler is configured.`);
        }

        metadataPayload = {
          ...metadataPayload,
          userDepositTxHash: userTxHash,
          gatewayApproveTxHash,
          gatewayDepositTxHash,
        };
      }

      // Now update the UI to state running
      // Build initial metro steps from the plan's steps (available in quote) or use defaults
      const defaultSteps: TrackerStep[] = [
        { label: "Validating policy & spend limits", tool: "RiskPolicyAgent", detail: "Checking risk policy, amount caps, and fee guards", status: "active" },
        { label: "Selecting optimal route", tool: "FeeQuoteAgent", detail: `Comparing routes for ${amount} USDC`, status: "pending" },
        { label: `Bridging via ${selectedQuote.circleProduct ?? selectedQuote.routeKind}`, tool: selectedQuote.routeKind, detail: `${CHAIN_SHORT[sourceChain] ?? sourceChain} → ${CHAIN_SHORT[destinationChain] ?? destinationChain}`, status: "pending" },
        { label: `Executing ${action} on ${selectedProtocolInfo?.name ?? protocol}`, tool: protocol, detail: `${amount} USDC on ${CHAIN_SHORT[destinationChain] ?? destinationChain}`, status: "pending" },
        { label: "Finalizing & recording receipt", tool: "JudgeNarratorAgent", detail: "Recording on-chain receipt and narration", status: "pending" },
      ];

      setTrackerSteps(defaultSteps);
      setExecutionPhase("running");
      setElapsedSec(0);
      setEstimatedTotalSec(selectedQuote.estimatedTimeSeconds || 30);
      setCompletedReceipt(null);
      setTxHash(null);

      // Start elapsed timer
      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

      // Fire the intent creation (this kicks off the pipeline)
      let receipt: any;
      let paymentHeader: string | undefined;

      const intentUrl = `${API_URL}/intents`;
      const intentPayload = {
        ...request,
        preferredRoute: routeKind as any,
        approved: true,
        metadata: metadataPayload
      };

      let res = await fetch(intentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intentPayload)
      });

      if (res.status === 402) {
        console.log("[FlowBuilder] 402 Payment Required for relayer execution.");
        if (!address || !connectedChainId) {
          setLoading(null);
          stopPolling();
          return setError("The API requires an EVM relayer-fee signature. Connect an EVM wallet with RainbowKit and retry.");
        }
        const challengeHeader = res.headers.get("PAYMENT-REQUIRED");
        if (!challengeHeader) throw new Error("402 Response missing PAYMENT-REQUIRED header.");
        const liveChallenge = decodeBase64Json(challengeHeader) as any;
        const requirement = liveChallenge.accepts?.find((item: any) => item.network === `eip155:${connectedChainId}`);
        if (!requirement) {
            setLoading(null);
            stopPolling();
            return setError(`The API requires a $0.05 USDC relayer nanopayment, but your connected network (Chain ID: ${connectedChainId}) is not supported for x402 signatures. Switch to Arc Testnet, Base Sepolia, or Ethereum Sepolia.`);
        }
        setLoading("signing_nanopayment");
        try {
            const typedData = buildGatewayPaymentAuth(address as `0x${string}`, requirement);
            const signature = await signTypedDataAsync({
              domain: typedData.domain,
              types: typedData.types,
              primaryType: typedData.primaryType,
              message: typedData.message
            });
            paymentHeader = encodeBase64Json({
              x402Version: liveChallenge.x402Version,
              resource: liveChallenge.resource,
              accepted: requirement,
              payload: { authorization: typedData.authorization, signature }
            });
            setLoading("execute");
        } catch (sigErr) {
            setLoading(null);
            stopPolling();
            return setError(`Relayer fee signature was rejected or failed: ${sigErr instanceof Error ? sigErr.message : String(sigErr)}`);
        }

        // Re-submit with payment
        res = await fetch(intentUrl, {
          method: "POST",
          headers: { 
            "content-type": "application/json",
            "Payment-Signature": paymentHeader 
          },
          body: JSON.stringify(intentPayload)
        });
      }

      if (!res.ok) throw new Error(`Intent creation failed: ${res.status} ${await res.text()}`);
      receipt = await res.json();
      const intentId = receipt.id;
      setExecutionIntentId(intentId);

      // If already completed (fast execution), finalize immediately
      if (receipt.status === "succeeded" || receipt.status === "failed" || receipt.status === "needs_approval") {
        stopPolling();
        const hash = receiptTxHash(receipt);
        if (hash) setTxHash(hash);
        const terminalStatus = receipt.status === "needs_approval" ? "failed" : receipt.status;
        setTrackerSteps(prev => decorateStepsWithReceipt(updateStepsFromStatus(prev, terminalStatus), receipt));
        if (receipt.status === "succeeded") {
          setTrackerSteps(prev => decorateStepsWithReceipt(prev.map(s => ({ ...s, status: "completed" as StepStatus })), receipt));
          setExecutionPhase("completed");
          setCompletedReceipt(receipt);
        } else {
          setExecutionPhase("failed");
          setCompletedReceipt(receipt);
          if (receipt.status === "needs_approval") {
            setError(formatError(approvalRationale(receipt)));
          }
        }
        setLoading(null);
        return;
      }

      // Start polling for status updates
      pollRef.current = setInterval(async () => {
        try {
          const updated = await client.getIntent(intentId);
          setTrackerSteps(prev => decorateStepsWithReceipt(updateStepsFromStatus(prev, updated.status), updated));

          const hash = receiptTxHash(updated);
          if (hash) setTxHash(hash);

          if (updated.status === "succeeded") {
            if (!updated.nftReceipt) return;
            stopPolling();
            setTrackerSteps(prev => decorateStepsWithReceipt(prev.map(s => ({ ...s, status: "completed" as StepStatus })), updated));
            setExecutionPhase("completed");
            setCompletedReceipt(updated);
            setLoading(null);
          } else if (updated.status === "failed" || updated.status === "needs_approval") {
            console.error("Execution failed. Intent details:", updated);
            stopPolling();
            setExecutionPhase("failed");
            setCompletedReceipt(updated);
            if (updated.status === "needs_approval") {
              setError(formatError(approvalRationale(updated)));
            }
            setLoading(null);
          }
        } catch {
          // polling error — ignore, will retry
        }
      }, 1500);

    } catch (err) {
      stopPolling();
      setError(formatError(err));
      setExecutionPhase("failed");
      setLoading(null);
    }
  }

  async function handleRetryNft() {
    if (!executionIntentId) return;
    setLoading("execute"); setError(null);
    try {
      const res = await fetch(`${API_URL}/intents/${executionIntentId}/retry-nft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Retry failed");
      setCompletedReceipt(data.receipt);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(null);
    }
  }

  function resetTracker() {
    stopPolling();
    setExecutionPhase("idle");
    setTrackerSteps([]);
    setExecutionIntentId(null);
    setElapsedSec(0);
    setCompletedReceipt(null);
    setTxHash(null);
  }

  // Determine if we need to switch chain
  const onWrongChain = sourceVm === "evm" && isConnected && connectedChain?.id !== sourceChainId;
  const needsSolanaSourceWallet = sourceVm === "svm" && !solanaAddress;
  const needsStellarSourceWallet = sourceVm === "soroban" && !stellarAddress;
  const needsSolanaReceiveWallet = destVm === "svm" && !solanaAddress;
  const needsStellarReceiveWallet = destVm === "soroban" && !stellarAddress;
  const showSolanaWalletBar = sourceVm === "svm" || destVm === "svm";
  const showStellarWalletBar = sourceVm === "soroban" || destVm === "soroban";

  const panelOpen = loading === "quote" || Boolean(quote) || executionPhase !== "idle";

  const swapTokens = CHAIN_SWAP_TOKENS[destinationChain] ?? [];

  async function handlePrimaryCta() {
    if (needsSolanaSourceWallet) return setError("Please connect your Solana wallet using the Connect Wallet button at the top left.");
    if (needsStellarSourceWallet) return setError("Please connect your Stellar wallet using the Connect Wallet button at the top left.");
    if (sourceVm === "evm" && (!isConnected || !address)) return setError("Connect your EVM wallet with RainbowKit to execute this route.");
    if (!selectedQuote) return getRoutes();
    if (onWrongChain) {
      if (sourceChainId) switchChain({ chainId: sourceChainId });
      return;
    }
    if (needsSolanaReceiveWallet) return setError("Please connect your Solana wallet using the Connect Wallet button at the top left.");
    if (needsStellarReceiveWallet) return setError("Please connect your Stellar wallet using the Connect Wallet button at the top left.");
    if (needsApproval) return handleApprove();
    return handleExecute();
  }

  const primaryCtaLabel =
    loading === "quote" ? "Updating Routes..." :
    loading === "approve" || approveConfirming ? "Approving..." :
    loading === "execute" || executionPhase === "running" ? "Executing..." :
    loading === "signing_nanopayment" ? "Sign Relayer Fee..." :
    txConfirming ? "Confirming..." :
    txSuccess ? "Confirmed" :
    executionPhase === "completed" ? "Transaction Complete" :
    needsSolanaSourceWallet ? "Solana Wallet Not Connected" :
    needsStellarSourceWallet ? "Stellar Wallet Not Connected" :
    sourceVm === "evm" && !isConnected ? "Connect Wallet to Execute" :
    !selectedQuote ? "Get Routes" :
    onWrongChain ? `Switch to ${CHAIN_SHORT[sourceChain] ?? sourceChain}` :
    needsSolanaReceiveWallet ? "Solana Wallet Not Connected" :
    needsStellarReceiveWallet ? "Stellar Wallet Not Connected" :
    needsApproval ? `Approve ${sourceDepositRequiredNumber.toFixed(6)} USDC` :
    sourceVm === "svm" ? "Transfer USDC with Phantom" :
    sourceVm === "soroban" ? "Transfer USDC with Freighter" :
    "Execute Transaction";

  return (
    <div className={`widget-container${panelOpen ? " panel-open" : ""}`}>

      {/* ── Left widget ───────────────────────────────── */}
      <section className="card widget">

        <div className="widget-header">
          <h2>Swap &amp; Bridge</h2>
          <div className="widget-header-right">
            <div className="settings-wrap">
              <button type="button" className="settings-btn" onClick={() => setShowAdvanced(!showAdvanced)} title="Advanced">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
              {showAdvanced && (
                <div className="advanced-popover" role="dialog" aria-label="Advanced settings">
                  <div className="advanced-grid">
                    <label>Slippage (bps)<input value={slippageBps} onChange={(e: any) => setSlippageBps(e.target.value)} type="number" /></label>
                    <label>AI Route
                      <select value={optimizationGoal} onChange={(e: any) => setOptimizationGoal(e.target.value)}>
                        {(config?.optimizationGoals ?? goals).map((g) => <option key={g}>{g}</option>)}
                      </select>
                    </label>
                    <label>Preferred Route
                      <select value={preferredRoute} onChange={(e: any) => setPreferredRoute(e.target.value)}>
                        {routes.map((r) => <option key={r} value={r}>{r || "AI decides"}</option>)}
                      </select>
                    </label>
                    <label>Max Fee (USDC)<input value={maxTotalFeeUsd} onChange={(e: any) => setMaxTotalFeeUsd(e.target.value)} type="number" /></label>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* EVM Wallet info bar — shown for EVM source routes */}
        {sourceVm === "evm" && isConnected && address && (
          <div className="wallet-bar">
            <span className="wallet-addr">{truncateAddr(address)}</span>
            {usdcBalance !== null && (
              <span className="wallet-balance">
                <span className="wallet-balance-label">USDC balance</span>
                <strong>{usdcBalance}</strong>
              </span>
            )}
            {onWrongChain && (
              <button className="wallet-switch-btn"
                onClick={() => sourceChainId && switchChain({ chainId: sourceChainId })}>
                Switch to {CHAIN_SHORT[sourceChain] ?? sourceChain}
              </button>
            )}
          </div>
        )}

        {/* Non-EVM wallet bar (shown when connected) */}
        {showSolanaWalletBar && solanaAddress && (
          <div className="wallet-bar non-evm-bar">
            <span className="wallet-addr" style={{ color: "#000", background: "transparent" }}>Solana {truncateAddr(solanaAddress)}</span>
            {solanaBalances && (
              <span className="wallet-balance" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                <span className="wallet-balance-label">Balances</span>
                <strong style={{ fontSize: "14px", color: "#000" }}>
                  {solanaBalances.usdc.toFixed(2)} USDC / {solanaBalances.sol.toFixed(3)} SOL
                </strong>
              </span>
            )}
            <button className="wallet-switch-btn" onClick={disconnectSolanaWallet}>Disconnect</button>
          </div>
        )}
        {showStellarWalletBar && stellarAddress && (
          <div className="wallet-bar non-evm-bar">
            <span className="wallet-addr" style={{ color: "#000", background: "transparent" }}>Stellar {truncateAddr(stellarAddress)}</span>
            {stellarBalances && (
              <span className="wallet-balance" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                <span className="wallet-balance-label">Balances</span>
                <strong style={{ fontSize: "14px", color: "#000" }}>
                  {stellarBalances.usdc.toFixed(2)} USDC / {stellarBalances.xlm.toFixed(2)} XLM
                </strong>
              </span>
            )}
            <button className="wallet-switch-btn" onClick={disconnectStellarWallet}>Disconnect</button>
          </div>
        )}

        <form onSubmit={(e) => e.preventDefault()}>
          {/* Amount + source chain */}
          <div className="input-block">
            <div className="input-row">
              <input type="number" className="amount-input" value={amount}
                onChange={(e: any) => setAmount(e.target.value)} placeholder="0.0" />
              <div className="amount-right">
                <div className="token-badge">USDC</div>
                {isConnected && usdcBalance !== null && (
                  <button type="button" className="max-btn"
                    onClick={() => setAmount(usdcBalance)}>MAX</button>
                )}
              </div>
            </div>
            <div className="chain-row">
              <label>From</label>
              <div className="select-wrap">
                <select value={sourceChain} onChange={(e: any) => setSourceChain(e.target.value)} className="minimal-select">
                  {chains.map((c) => (
                    <option key={c.key} value={c.key} disabled={Boolean(DISABLED_SOURCE_CHAIN_REASON[c.key])}>
                      {DISABLED_SOURCE_CHAIN_REASON[c.key] ? `${c.name} (source unavailable)` : c.name}
                    </option>
                  ))}
                </select>
                <ChevronIcon />
              </div>
            </div>
          </div>

          <div className="flow-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M19 12l-7 7-7-7"/>
            </svg>
          </div>

          {/* Action + destination + protocol */}
          <div className="input-block">
            <div className="action-row">
              <div className="select-wrap">
                <select value={action} onChange={(e: any) => setAction(e.target.value)} className="action-select">
                  {allowedActions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
                <ChevronIcon />
              </div>
            </div>
            <div className="chain-row">
              <label>To</label>
              <div className="select-wrap">
                <select value={destinationChain} onChange={(e: any) => setDestinationChain(e.target.value)} className="minimal-select">
                  {chains.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </select>
                <ChevronIcon />
              </div>
            </div>
            <div className="chain-row" style={{ marginTop: "12px" }}>
              <label>Protocol</label>
              <div className="select-wrap">
                <select value={protocol} onChange={(e: any) => setProtocol(e.target.value)}
                  className="minimal-select" disabled={protocolsForDestination.length === 0}>
                  {protocolsForDestination.length === 0
                    ? <option value="">No protocol on this chain</option>
                    : protocolsForDestination.map((p) => (
                        <option key={p.key} value={p.key}>{p.name} · {p.type}</option>
                      ))}
                </select>
                <ChevronIcon />
              </div>
            </div>
            {protocolsForDestination.length === 0 && destChainInfo && (
              <p className="hint">No adapter registered on {destChainInfo.name} yet.</p>
            )}
          </div>

          {/* ── Protocol-specific parameters ─────────────────────────── */}
          {selectedProtocolInfo && (
            <div className="protocol-params">
              {isDexProtocol(selectedProtocolInfo.type) && action === "swap" && (
                <>
                  <div className="param-row">
                    <label>Swap to</label>
                    <div className="param-token-wrap">
                      {swapTokens.length > 0 && (
                        <div className="select-wrap">
                          <select
                            className="param-select"
                            value={tokenOut === "custom" ? "custom" : (swapTokens.some(t => t.address === tokenOut) ? tokenOut : "custom")}
                            onChange={(e: any) => {
                              if (e.target.value === "custom") {
                                setTokenOut("custom");
                              } else {
                                setTokenOut(e.target.value);
                                setCustomTokenOut("");
                              }
                            }}>
                            {swapTokens.map((t) => (
                              <option key={t.address} value={t.address} title={t.note ?? t.address}>{t.symbol}</option>
                            ))}
                            <option value="custom">Custom address…</option>
                          </select>
                          <ChevronIcon />
                        </div>
                      )}
                      {(tokenOut === "custom" || swapTokens.length === 0) && (
                        <input
                          type="text"
                          className="param-input"
                          placeholder={
                            destinationChain === "SOLANA_DEVNET"
                              ? "Token mint address"
                              : destinationChain === "STELLAR_TESTNET"
                              ? "Asset contract ID"
                              : "0x ERC-20 token address"
                          }
                          value={customTokenOut}
                          onChange={(e: any) => setCustomTokenOut(e.target.value)}
                        />
                      )}
                    </div>
                  </div>
                  {!tokenOut && swapTokens.length === 0 && (
                    <p className="hint" style={{ marginTop: 0 }}>Enter the output token address for this swap.</p>
                  )}
                </>
              )}

              {/* Aave V3 / lending: show asset info */}
              {selectedProtocolInfo.key === "ETH_AAVE_V3" && (
                <>
                  <div className="param-row">
                    <label>Supplies</label>
                    <span className="param-badge">USDC → WETH</span>
                  </div>
                  <div className="param-row">
                    <label>Receive</label>
                    <span className="param-badge">aEthWETH</span>
                  </div>
                </>
              )}

              {/* Morpho Blue: market note */}
              {selectedProtocolInfo.key === "BASE_MORPHO_BLUE" && (
                <>
                  <div className="param-row">
                    <label>Receive</label>
                    <span className="param-badge">Morpho USDC shares</span>
                  </div>
                  <p className="protocol-note">
                    Morpho Blue uses immutable market parameters. Supply, collateral, withdraw, borrow, and repay
                    are encoded from metadata when a market is provided.
                  </p>
                </>
              )}

              {selectedProtocolInfo.key === "SOL_MARINADE" && (
                <>
                  <div className="param-row">
                    <label>Route</label>
                    <span className="param-badge">USDC → SOL</span>
                  </div>
                  <div className="param-row">
                    <label>Receive</label>
                    <span className="param-badge">mSOL</span>
                  </div>
                </>
              )}

              {/* Kamino / generic lending: asset label */}
              {isLendingProtocol(selectedProtocolInfo.type) &&
               selectedProtocolInfo.key !== "ETH_AAVE_V3" &&
               selectedProtocolInfo.key !== "BASE_MORPHO_BLUE" &&
               selectedProtocolInfo.key !== "SOL_MARINADE" &&
               (
                <div className="param-row">
                  <label>Receive</label>
                  <span className="param-badge">{receiptTokenForProtocol(selectedProtocolInfo.key, action)?.symbol ?? "USDC"}</span>
                </div>
              )}

              {/* Gateway: bridge note */}
              {selectedProtocolInfo.key === "ARC_GATEWAY" && (
                <p className="protocol-note">
                  Circle Gateway Wallet — USDC balance unified across chains.
                  Bridging is handled automatically via CCTP attestation.
                </p>
              )}
            </div>
          )}

          {/* CCTP attestation info when cross-chain */}
          {sourceChain !== destinationChain && (
            <p className="cctp-note">
              Cross-chain transfer uses CCTP — Circle's attestation is fetched automatically after the source burn. No manual second call needed.
            </p>
          )}

          {/* CTA buttons */}
          <div className="action-buttons">
            <button type="button" className="btn-primary"
              disabled={loading !== null || !protocol || txConfirming || executionPhase === "running"}
              onClick={handlePrimaryCta}>
              {primaryCtaLabel}
            </button>
            {selectedQuote && needsApproval && routerAddress && (
              <div className="approval-debug">
                Current allowance {allowanceAmount.toFixed(6)} USDC to {truncateAddr(routerAddress)}
              </div>
            )}
          </div>

          {error && <p className="error-msg">{error}</p>}

          {/* Tx hash link (shown inline only if tracker is not visible) */}
          {txHash && executionPhase === "idle" && (
            <p className="tx-link">
              Tx: <a href={txExplorerUrl(destinationChain, txHash)} target="_blank" rel="noreferrer">{truncateAddr(txHash)}</a>
            </p>
          )}
        </form>
      </section>

      {/* ── Right: Route panel OR Transaction Tracker ────────── */}
      <div className={`route-panel${panelOpen ? " open" : ""}`}>
        {executionPhase !== "idle" ? (
          <TransactionTracker
            steps={trackerSteps}
            phase={executionPhase}
            elapsedSec={elapsedSec}
            estimatedTotalSec={estimatedTotalSec}
            receipt={completedReceipt}
            txHash={txHash}
            amount={amount}
            sourceChain={sourceChain}
            destinationChain={destinationChain}
            protocolName={selectedProtocolInfo?.name ?? protocol}
            protocolKey={protocol}
            action={action}
            routeKind={selectedQuote?.routeKind ?? ""}
            onClose={resetTracker}
            onRetryNft={handleRetryNft}
            loading={loading}
          />
        ) : loading === "quote" ? (
          <RouteLoadingPanel />
        ) : quote?.selected ? (
          <ReceivePanel
            quote={quote}
            sourceChain={sourceChain}
            destinationChain={destinationChain}
            protocolInfo={selectedProtocolInfo}
            action={action}
            preferredRoute={preferredRoute}
            onSelectRoute={async (routeKind) => {
              setPreferredRoute(routeKind);
              const selectedAlternative = quote.alternatives?.find((alt: any) => alt.eligible && alt.routeKind === routeKind);
              if (selectedAlternative?.feeQuote) {
                setQuote({
                  ...quote,
                  selected: selectedAlternative.feeQuote,
                  plan: {
                    ...quote.plan,
                    feeQuote: selectedAlternative.feeQuote
                  }
                });
              }
              setLoading("quote"); setError(null); setTxHash(null);
              try {
                const response = await client.quote({ ...request, preferredRoute: routeKind as any });
                setQuote(response);
              } catch (err) {
                setError(formatError(err));
              } finally {
                setLoading(null);
              }
            }}
            onClose={() => setQuote(null)}
          />
        ) : quote ? (
          <NoRoutePanel quote={quote} onClose={() => setQuote(null)} />
        ) : null}
      </div>
    </div>
  );
}
// ─── Metro-style Transaction Tracker ─────────────────────────────────────────

function TransactionTracker({ steps, phase, elapsedSec, estimatedTotalSec, receipt, txHash, amount, sourceChain, destinationChain, protocolName, protocolKey, action, routeKind, onClose, onRetryNft, loading }: {
  steps: Array<{ label: string; tool: string; detail: string; status: string; links?: Array<{ label: string; value: string; href?: string }> }>;
  phase: "idle" | "running" | "completed" | "failed";
  elapsedSec: number;
  estimatedTotalSec: number;
  receipt: any;
  txHash: string | null;
  amount: string;
  sourceChain: string;
  destinationChain: string;
  protocolName: string;
  protocolKey: string;
  action: string;
  routeKind: string;
  onClose: () => void;
  onRetryNft: () => void;
  loading: string | null;
}) {
  const completedCount = steps.filter(s => s.status === "completed").length;
  const progressPct = phase === "completed" ? 100 : phase === "failed" ? (completedCount / steps.length) * 100 : steps.length > 0 ? (completedCount / steps.length) * 100 : 0;
  const remaining = Math.max(0, estimatedTotalSec - elapsedSec);
  const actionLabel = action === "swap" ? "Swap" : action === "supply" ? "Supply" : action === "withdraw" ? "Withdraw" : action === "borrow" ? "Borrow" : "Transfer";
  const routeColor = ROUTE_COLOR[routeKind] ?? "#6b7280";
  const protocolOutputSymbol = displayProtocolOutputSymbol(
    receipt?.input?.protocol ?? protocolKey,
    receipt?.input?.action ?? action,
    receipt?.protocolReceipt?.amountOutSymbol ?? receipt?.protocolReceipt?.tokenOutSymbol
  );
  const protocolOut = receipt?.protocolReceipt?.amountOutFormatted
    ? `${receipt.protocolReceipt.amountOutFormatted} ${protocolOutputSymbol}`.trim()
    : null;
  const protocolIn = receipt?.protocolReceipt?.executedAmountUsdc
    ? `${receipt.protocolReceipt.executedAmountUsdc} ${receipt.protocolReceipt.tokenInSymbol ?? "USDC"}`
    : `${amount} USDC`;
  const bridgeReceived = receipt?.bridgeReceipt?.destinationRouterAmountReceivedUsdc
    ? `${receipt.bridgeReceipt.destinationRouterAmountReceivedUsdc} USDC`
    : null;
  const actualFeeUsd = receipt?.actualFeeUsd && Number(receipt.actualFeeUsd) > 0 ? receipt.actualFeeUsd : null;
  const quotedFeeUsd = receipt?.plan?.feeQuote?.userPaysUsd;

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="tx-tracker">
      {/* Header */}
      <div className="tx-tracker-header">
        <h3 className="tx-tracker-title">
          <span className="tx-tracker-title-icon">⚡</span>
          {phase === "completed" ? "Transaction Complete" : phase === "failed" ? "Transaction Failed" : "Transaction Progress"}
        </h3>
        {(phase === "completed" || phase === "failed") && (
          <button className="tx-tracker-close" onClick={onClose} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="tx-progress-bar">
        <div className="tx-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Transaction summary badge */}
      <div className="tx-summary-badge">
        <span><strong>{amount} USDC</strong> · {actionLabel} on {CHAIN_SHORT[destinationChain] ?? destinationChain}</span>
        <span className="tx-summary-route" style={{ color: routeColor, background: `${routeColor}18`, border: `1px solid ${routeColor}44` }}>{routeKind}</span>
      </div>

      {/* Timer */}
      {phase === "running" && (
        <div className="tx-timer">
          <div className="tx-timer-block">
            <span className="tx-timer-label">Elapsed</span>
            <span className="tx-timer-value">{formatTime(elapsedSec)}</span>
          </div>
          <div className="tx-timer-divider" />
          <div className="tx-timer-block" style={{ textAlign: "right" }}>
            <span className="tx-timer-label">Est. Remaining</span>
            <span className="tx-timer-value remaining">{remaining > 0 ? formatTime(remaining) : "Any moment"}</span>
          </div>
        </div>
      )}

      {/* Metro stations */}
      <div className="metro-stations">
        {steps.map((step, i) => {
          const icons: Record<string, string> = {
            completed: "✓",
            active: String(i + 1),
            pending: String(i + 1),
            failed: "✗"
          };
          return (
            <div key={i} className={`metro-station ${step.status}`}>
              <div className="metro-dot">{icons[step.status] ?? String(i + 1)}</div>
              <div className="metro-rail" />
              <div className="metro-content">
                <div className="metro-label">{step.label}</div>
                <div className="metro-detail">{step.detail}</div>
                {step.links && step.links.length > 0 && (
                  <div className="metro-links">
                    {step.links.map((link) => (
                      link.href ? (
                        <a key={`${link.label}-${link.value}`} href={link.href} target="_blank" rel="noreferrer">
                          {link.label}: {truncateAddr(link.value)} ↗
                        </a>
                      ) : (
                        <span key={`${link.label}-${link.value}`}>{link.label}: {truncateAddr(link.value)}</span>
                      )
                    ))}
                  </div>
                )}
                {step.status === "active" && (
                  <div className="metro-status-chip active">
                    <span className="metro-spinner" /> Processing
                  </div>
                )}
                {step.status === "completed" && (
                  <div className="metro-status-chip completed">Done</div>
                )}
                {step.status === "failed" && (
                  <div className="metro-status-chip failed">Failed</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Completion summary */}
      {phase === "completed" && receipt && (
        <div className="tx-complete-summary">
          <div className="tx-complete-header">
            <div className="tx-complete-icon">✓</div>
            <div>
              <p className="tx-complete-title">Transaction Successful</p>
              <p className="tx-complete-sub">
                {actionLabel} {protocolIn} on {CHAIN_SHORT[destinationChain] ?? destinationChain}
              </p>
            </div>
          </div>

          {txHash && (
            <div className="tx-complete-row">
              <span>Transaction</span>
              <a href={txExplorerUrl(destinationChain, txHash)} target="_blank" rel="noreferrer">
                {truncateAddr(txHash)} ↗
              </a>
            </div>
          )}

          {(actualFeeUsd ?? quotedFeeUsd) && (
            <div className="tx-complete-row">
              <span>{actualFeeUsd ? "Actual tx fees" : "Estimated fees"}</span>
              <strong>{actualFeeUsd ?? quotedFeeUsd} USDC</strong>
            </div>
          )}

          {bridgeReceived && (
            <div className="tx-complete-row">
              <span>Bridge received</span>
              <strong>{bridgeReceived}</strong>
            </div>
          )}

          {protocolOut && (
            <div className="tx-complete-row">
              <span>Protocol output</span>
              <strong>{protocolOut}</strong>
            </div>
          )}

          <div className="tx-complete-row">
            <span>Route</span>
            <strong style={{ color: routeColor }}>{routeKind}</strong>
          </div>

          <div className="tx-complete-row">
            <span>Duration</span>
            <strong>{formatTime(elapsedSec)}</strong>
          </div>

          {/* NFT receipt */}
          {receipt.nftReceipt && !receipt.nftReceipt.skipped && receipt.nftReceipt.tokenId && (
            <div className="metro-nft-inline">
              <span className="metro-nft-badge">NFT</span>
              <span className="metro-nft-text">Receipt #{receipt.nftReceipt.tokenId} · Arc Testnet</span>
              {receipt.nftReceipt.mintTxHash && (
                <a className="metro-nft-link" href={`https://testnet.arcscan.app/tx/${receipt.nftReceipt.mintTxHash}`} target="_blank" rel="noreferrer">View ↗</a>
              )}
            </div>
          )}
          {receipt.nftReceipt?.skipped && (
            <div className="metro-nft-inline" style={{ borderColor: "rgba(245,158,11,.3)" }}>
              <span className="metro-nft-badge" style={{ background: "linear-gradient(135deg, #f59e0b, #fbbf24)" }}>NFT</span>
              <span className="metro-nft-text">{receipt.nftReceipt.reason ?? "Mint skipped"}</span>
              <button className="metro-nft-retry-btn" onClick={onRetryNft} disabled={loading !== null}>
                {loading === "execute" ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Failed summary */}
      {phase === "failed" && (
        <div className="tx-failed-summary">
          <div className="tx-failed-header">
            <div className="tx-failed-icon">✗</div>
            <div>
              <p className="tx-failed-title">Transaction Failed</p>
            </div>
          </div>
          <p className="tx-failed-msg">{receipt?.error ? formatError(receipt.error) : "An error occurred during execution. Please try again."}</p>
          <button className="tx-retry-btn" onClick={onClose}>Dismiss & Try Again</button>
        </div>
      )}
    </div>
  );
}

// ─── Receive panel (Jumper-style) ────────────────────────────────────────────

function outputSymbol(fq: any, protocolInfo?: ProtocolInfo | null, action = "supply") {
  return displayProtocolOutputSymbol(protocolInfo?.key ?? fq.protocol, action, fq.outputTokenSymbol ?? fq.asset ?? "USDC");
}

function outputAmount(fq: any) {
  return fq.estimatedOutputAmount ?? fq.estimatedAmountToProtocol ?? fq.amountIn ?? "0";
}

function minimumOutputAmount(fq: any) {
  return fq.minimumOutputAmount ?? fq.minimumReceived ?? outputAmount(fq);
}

function gasDisplay(fq: any, side: "source" | "destination") {
  const amount = side === "source" ? fq.sourceGasAmount : fq.destinationGasAmount;
  const token = side === "source" ? fq.sourceGasToken : fq.destinationGasToken;
  if (amount !== undefined && token) return `${amount} ${token}`;
  const usdValue = side === "source" ? fq.sourceGasUsd : fq.destinationGasUsd;
  return `$${Number(usdValue ?? 0).toFixed(4)}`;
}

function networkGasDisplay(fq: any) {
  const sourceAmount = Number(fq.sourceGasAmount ?? 0);
  const destinationAmount = Number(fq.destinationGasAmount ?? 0);
  const sourceToken = fq.sourceGasToken;
  const destinationToken = fq.destinationGasToken;
  if (sourceToken && destinationToken) {
    if (sourceToken === destinationToken) {
      return `${(sourceAmount + destinationAmount).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} ${sourceToken}`;
    }
    const parts = [];
    if (sourceAmount > 0) parts.push(gasDisplay(fq, "source"));
    if (destinationAmount > 0) parts.push(gasDisplay(fq, "destination"));
    return parts.join(" + ") || "0";
  }
  return `$${Number(fq.networkGasUsd ?? Number(fq.sourceGasUsd ?? 0) + Number(fq.destinationGasUsd ?? 0)).toFixed(4)}`;
}

function RouteLoadingPanel() {
  return (
    <div className="rp-panel route-loading-panel" aria-live="polite" aria-busy="true">
      <div className="rp-header">
        <h3 className="rp-title">Finding routes</h3>
        <span className="route-loading-spinner" />
      </div>
      <div className="route-loading-copy">
        Simulating bridge fees, gas, and protocol output.
      </div>
      <div className="route-loading-stack">
        {[0, 1, 2].map((item) => (
          <div className="route-loading-card" key={item}>
            <div className="route-loading-icon" />
            <div className="route-loading-lines">
              <span />
              <span />
            </div>
            <div className="route-loading-pill" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ReceivePanel({ quote, sourceChain, destinationChain, protocolInfo, action, preferredRoute, onSelectRoute, onClose }: {
  quote: QuoteResult; sourceChain: string; destinationChain: string;
  protocolInfo: ProtocolInfo | null; action: string; preferredRoute: string;
  onSelectRoute: (routeKind: string) => void | Promise<void>; onClose: () => void;
}) {
  const selected = normalizeFeeQuoteEta(quote.selected)!;
  const eligibleAlts = (quote.alternatives ?? []).filter((a: any) => a.eligible);
  const sorted = [
    eligibleAlts.find((a: any) => a.routeKind === selected.routeKind),
    ...eligibleAlts.filter((a: any) => a.routeKind !== selected.routeKind)
  ].filter(Boolean) as any[];

  const [expandedRoute, setExpandedRoute] = useState<string>(selected.routeKind);

  return (
    <div className="rp-panel">
      <div className="rp-header">
        <h3 className="rp-title">Receive</h3>
        <button className="rp-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div className="rp-cards">
        {sorted.map((alt: any) => {
          const fq = normalizeFeeQuoteEta(alt.feeQuote ?? selected)!;
          const estimatedTimeSeconds = routeEstimatedTimeSeconds(alt.routeKind, fq.estimatedTimeSeconds ?? alt.estimatedTimeSeconds ?? 30);
          const isExpanded = expandedRoute === alt.routeKind;
          const isBest = alt.routeKind === selected.routeKind;
          const isSelected = preferredRoute ? preferredRoute === alt.routeKind : isBest;
          const outSymbol = outputSymbol(fq, protocolInfo, action);
          const outAmount = outputAmount(fq);
          const minOutAmount = minimumOutputAmount(fq);
          const badgeLabel = isBest
            ? (selected.confidence === "high" ? "Best Return" : "Good Route")
            : isSelected ? "Selected"
            : estimatedTimeSeconds < 20 ? "Fastest" : alt.routeKind;
          const color = ROUTE_COLOR[alt.routeKind] ?? "#6b7280";

          return (
            <div key={alt.routeKind}
              className={`rp-card${isExpanded ? " rp-card--open" : ""}${isSelected ? " rp-card--selected" : ""}`}
              onClick={() => setExpandedRoute(isExpanded ? "" : alt.routeKind)}>

              <div className="rpc-header">
                <div className="rpc-icon" style={{ background: `${color}22`, border: `1px solid ${color}55`, color }}>
                  {protocolInitials(fq.circleProduct ?? alt.routeKind)}
                </div>
                <div className="rpc-main">
                  <div className="rpc-amount">{outAmount} <span>{outSymbol}</span></div>
                  <div className="rpc-sub">on {CHAIN_SHORT[destinationChain] ?? destinationChain}{protocolInfo && <> · {protocolInfo.name}</>}</div>
                </div>
                <div className="rpc-right">
                  <span className="rpc-badge" style={{ color, background: `${color}18`, borderColor: `${color}44` }}>{badgeLabel}</span>
                  <svg className={`rpc-chevron${isExpanded ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                </div>
              </div>

              {isExpanded && (
                <div className="rpc-body" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="rpc-select-route"
                    disabled={isSelected}
                    onClick={() => onSelectRoute(alt.routeKind)}>
                    {isSelected ? `Using ${alt.routeKind}` : `Use ${alt.routeKind}`}
                  </button>
                  <div className="rpc-inline-meta">
                    <span>Network cost</span>
                    <span className="rpc-meta-val">{networkGasDisplay(fq)}</span>
                    <span>Source gas</span>
                    <span className="rpc-meta-val">{gasDisplay(fq, "source")}</span>
                    <span>Dest. gas</span>
                    <span className="rpc-meta-val">{gasDisplay(fq, "destination")}</span>
                    <span>Price impact</span>
                    <span className="rpc-meta-val">{fq.slippageBps > 0 ? `-${(fq.slippageBps / 100).toFixed(2)}%` : "0%"}</span>
                    <span>Max. slippage</span>
                    <span className="rpc-meta-val">{(fq.slippageBps / 100).toFixed(2)}%</span>
                    <span>Min. received</span>
                    <span className="rpc-meta-val">{minOutAmount} {outSymbol}</span>
                    <span>Bridge fee</span>
                    <span className="rpc-meta-val">{Number(fq.bridgeFeeUsd) > 0 ? `${fq.bridgeFeeUsd} USDC` : "Free"}</span>
                    <span>Wallet transfer</span>
                    <span className="rpc-meta-val">{fq.sourceDepositRequiredUsd ?? fq.amountIn} USDC</span>
                    <span>Estimated time</span>
                    <span className="rpc-meta-val">{estimatedTimeSeconds >= 60 ? `${Math.round(estimatedTimeSeconds / 60)}m` : `${estimatedTimeSeconds}s`}</span>
                  </div>
                  <div className="rpc-steps">
                    <RouteSteps
                      routeKind={alt.routeKind} sourceChain={sourceChain} destinationChain={destinationChain}
                      circleProduct={fq.circleProduct} protocolName={protocolInfo?.name ?? fq.protocol}
                      action={action} amountIn={fq.amountIn} amountOut={outAmount} outputToken={outSymbol}
                      protocolInputAmount={fq.estimatedAmountToProtocol}
                      bridgeFeeUsd={fq.bridgeFeeUsd} destinationGas={gasDisplay(fq, "destination")}
                    />
                  </div>
                  <div className="rpc-pays-row">
                    <span>Est. total cost</span>
                    <strong>{fq.userPaysUsd} USDC equiv.</strong>
                  </div>
                  <div className="rpc-pays-row" style={{ borderColor: "rgba(245,158,11,.15)", background: "rgba(245,158,11,.04)" }}>
                    <span>Wallet gas</span>
                    <span style={{ color: "#f59e0b", fontSize: 12 }}>Shown in native tokens; USD only scores routes</span>
                  </div>
                  {/* Gas source indicator */}
                  {fq.assumptions && fq.assumptions.some((a: string) => a.includes("simulated") || a.includes("simulation")) && (
                    <div className="rpc-live-badge">
                      <span className="live-dot" />
                      Full-flow simulation
                    </div>
                  )}
                  {fq.assumptions && fq.assumptions.some((a: string) => a.includes("Circle Iris API")) && (
                    <div className="rpc-live-badge">
                      <span className="live-dot" />
                      Bridge fee live from Circle API
                    </div>
                  )}
                  {fq.warnings?.length > 0 && (
                    <div className="rpc-warnings">
                      {fq.warnings.map((w: string) => <p key={w}>{w}</p>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RouteSteps({ routeKind, sourceChain, destinationChain, circleProduct, protocolName, action, amountIn, amountOut, outputToken, protocolInputAmount, bridgeFeeUsd, destinationGas }: {
  routeKind: string; sourceChain: string; destinationChain: string;
  circleProduct: string; protocolName: string; action: string;
  amountIn: string; amountOut: string; outputToken: string; protocolInputAmount: string;
  bridgeFeeUsd: string; destinationGas: string;
}) {
  const isSameChain = sourceChain === destinationChain;
  const actionLabel = action === "swap" ? "Swap" : action === "supply" ? "Supply" : action === "withdraw" ? "Withdraw" : action === "borrow" ? "Borrow" : action === "repay" ? "Repay" : "Transfer";
  const srcLabel = CHAIN_SHORT[sourceChain] ?? sourceChain;
  const dstLabel = CHAIN_SHORT[destinationChain] ?? destinationChain;
  const steps = isSameChain
    ? [{ icon: "◆", text: `${actionLabel} on ${srcLabel} via ${protocolName}`, detail: `${amountIn} USDC → ${amountOut} ${outputToken}` }]
    : [
        { icon: "⬡", text: `Bridge from ${srcLabel} to ${dstLabel} via ${circleProduct}`, detail: `${amountIn} USDC → ${protocolInputAmount} USDC · fee ${Number(bridgeFeeUsd) > 0 ? bridgeFeeUsd + " USDC" : "free"}` },
        { icon: "◆", text: `${actionLabel} on ${dstLabel} via ${protocolName}`, detail: `${protocolInputAmount} USDC → ${amountOut} ${outputToken} · exec gas ${destinationGas}` }
      ];
  return (
    <>
      {steps.map((step, i) => (
        <div key={i} className="rps-step">
          <div className="rps-dot">{step.icon}</div>
          {i < steps.length - 1 && <div className="rps-line" />}
          <div className="rps-info">
            <div className="rps-text">{step.text}</div>
            <div className="rps-detail">{step.detail}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function NoRoutePanel({ quote, onClose }: { quote: QuoteResult; onClose: () => void }) {
  const alternatives = quote.alternatives ?? [];
  const rationale = Array.isArray(quote.plan?.rationale) ? quote.plan.rationale : [];
  const messages = [
    ...rationale,
    ...alternatives.flatMap((alt: any) => alt.rejectionReasons ?? [])
  ].join(" ");
  const isRateLimited = /rate.?limit|too many requests|HTTP 429|retry in a few seconds/i.test(messages);
  return (
    <div className="rp-panel">
      <div className="rp-header">
        <h3 className="rp-title">{isRateLimited ? "Simulation rate limited" : "No route available"}</h3>
        <button className="rp-close" onClick={onClose} title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div className="rp-cards">
        <div className="rp-card rp-card--open">
          <div className="rpc-body" style={{ display: "block" }}>
            <div className="rpc-warnings">
              {rationale.map((line: string) => <p key={line}>{line}</p>)}
              {alternatives.length === 0 && <p>No bridge route was returned for this source, destination, and protocol.</p>}
              {alternatives.map((alt: any) => (
                <p key={alt.routeKind}>
                  {alt.routeKind}: {alt.rejectionReasons?.length ? alt.rejectionReasons.join("; ") : alt.reason}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6"/>
    </svg>
  );
}
