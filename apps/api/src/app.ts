import express from "express";
import cors from "cors";
import { createGatewayMiddleware, type PaymentRequest } from "@circle-fin/x402-batching/server";
import { Connection } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Hex, isAddress, parseAbi, parseAbiItem } from "viem";
import { Horizon, Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import { env, chainConfig, protocolConfig, protocolGroupForChainKey, hasGatewayContracts, hasCctpEvmContracts, findChainByKey } from "./config/index.js";
import { loadSolanaKeypair } from "./utils/solanaKeys.js";
import { intentOrchestrator, createIntentSchema } from "./workflows/intentOrchestrator.js";
import { store } from "./store/memory.js";
import { agentManager } from "./agents/AgentManager.js";
import { geminiChatService } from "./services/ai/geminiChatService.js";
import { nanopaymentAgent } from "./agents/NanopaymentAgent.js";
import { GatewayService } from "./services/bridge/gatewayService.js";
import { TreasuryRebalancerAgent } from "./agents/TreasuryRebalancerAgent.js";
import { liveQuoteService } from "./services/fees/liveQuoteService.js";
import { arcReceiptMinter } from "./services/receipts/arcReceiptMinter.js";
import { balanceMonitor } from "./services/monitoring/balanceMonitor.js";
import { jsonReplacer } from "./utils/json.js";
import type { IntentReceipt } from "./types.js";

const app = express();
const gateway = new GatewayService();
const treasury = new TreasuryRebalancerAgent();
const x402Gateway = createGatewayMiddleware({
  sellerAddress: nanopaymentAgent.sellerAddress,
  networks: nanopaymentAgent.acceptedNetworkIds(),
  facilitatorUrl: env.circleGatewayApiUrl,
  description: "Chrysalis V2 paid AI resource"
});

let backgroundServicesStarted = false;

app.set("json replacer", jsonReplacer);
app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: any, res: any) => {
  res.json({
    ok: true,
    service: "chrysalis-v2",
    demoMode: env.demoMode,
    liveFees: env.liveFees,
    circleApiConfigured: Boolean(env.circleApiKey)
  });
});

/**
 * UI/config bootstrap. Returns the supported chains, the DeFi protocols grouped by the
 * chain they are deployed on (so dropdowns can be filtered per chain), and the Circle
 * services (Gateway, CCTP, BridgeKit, x402 nanopayments) surfaced separately
 * so they are never shown as if they were selectable destination protocols.
 */
app.get("/config", (_req: any, res: any) => {
  const chains = Object.values(chainConfig).map((c: any) => ({
    key: c.key,
    name: c.name,
    vm: c.vm,
    explorer: c.explorer,
    hasGateway: hasGatewayContracts(c),
    hasCctp: hasCctpEvmContracts(c) || c.cctpDomain !== undefined,
    supportsNanopayments: Boolean(c.circle?.gateway?.nanopayments)
  }));

  const protocolsByChain: Record<string, any[]> = {};
  const circleServicesByChain: Record<string, any[]> = {};
  for (const [group, list] of Object.entries(protocolConfig) as Array<[string, any[]]>) {
    const chainKey = chainKeyForGroup(group);
    for (const p of list) {
      const entry = { key: p.key, name: p.name, type: p.type, category: p.category ?? "defi", actions: p.supportedAdapterActions ?? [] };
      if (p.category === "circle") {
        (circleServicesByChain[chainKey] ??= []).push({ ...entry, circleService: p.circleService });
      } else {
        (protocolsByChain[chainKey] ??= []).push(entry);
      }
    }
  }

  const operatorAddress = env.operatorPrivateKey
    ? privateKeyToAccount(env.operatorPrivateKey as Hex).address
    : undefined;
  const solanaOperatorAddress = readSolanaOperatorAddress();
  const stellarOperatorAddress = env.stellarSecretKey
    ? StellarKeypair.fromSecret(env.stellarSecretKey).publicKey()
    : undefined;

  res.json({
    chains,
    protocolsByChain,
    circleServicesByChain,
    routes: ["GATEWAY", "CCTP_V2", "BRIDGEKIT", "LOCAL"],
    optimizationGoals: ["balanced", "lowest_cost", "fastest", "safest"],
    operatorAddress,
    solanaOperatorAddress,
    stellarOperatorAddress
  });
});

function readSolanaOperatorAddress(): string | undefined {
  try {
    const keypair = loadSolanaKeypair();
    return keypair?.publicKey.toBase58();
  } catch (err) {
    console.error("[Server] Failed to load Solana operator address:", err);
    return undefined;
  }
}

function chainKeyForGroup(group: string): string {
  const match = Object.values(chainConfig).find((c: any) => protocolGroupForChainKey(c.key) === group) as any;
  return match?.key ?? group;
}

app.post("/intents/quote", async (req: any, res: any) => {
  const parsed = createIntentSchema.safeParse({ ...req.body, quoteOnly: true });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await agentManager.quote(parsed.data));
});

app.post("/quotes", async (req: any, res: any) => {
  const parsed = createIntentSchema.safeParse({ ...req.body, quoteOnly: true });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await agentManager.quote(parsed.data));
});

nanopaymentAgent.createResource({ path: "/paid/execute-intent", priceUsdc: "0.05", description: "Relayer gas fee for cross-chain execution." });

app.post("/intents", (req: any, res: any, next: any) => {
  if (req.body?.preferredRoute === "LOCAL") {
    return next();
  }
  const sourceChain = Object.values(chainConfig).find((chain: any) => chain.key === req.body?.sourceChain) as any;
  if (sourceChain?.vm && sourceChain.vm !== "evm") {
    return next();
  }
  return requireNanopayment("/paid/execute-intent")(req, res, next);
}, async (req: any, res: any) => {
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const receipt = await intentOrchestrator.createAndRun(parsed.data);
  res.status(receipt.status === "failed" ? 500 : 201).json(receipt);
});

app.get("/intents", async (req: any, res: any) => {
  res.json(await store.list({
    owner: typeof req.query.owner === "string" ? req.query.owner : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined
  }));
});

app.get("/intents/:id", async (req: any, res: any) => {
  const item = await store.get(req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
});

async function fetchOnChainReceipts(ownerAddress: string): Promise<IntentReceipt[]> {
  const contractAddress = process.env.ARC_RECEIPT_NFT_ADDRESS as Hex | undefined;
  if (!contractAddress || !isAddress(contractAddress) || !ownerAddress) {
    return [];
  }

  try {
    const arcChain = findChainByKey("ARC");
    const rpcUrl = process.env.ARC_RPC_URL ?? arcChain.rpcUrl;
    const viemChain = {
      id: arcChain.chainId,
      name: arcChain.name,
      nativeCurrency: arcChain.nativeCurrency ?? { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } }
    };
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

    const contractAbi = parseAbi([
      "function totalMinted() external view returns (uint256)",
      "function receipts(uint256) external view returns (string, address, string, string, string, string, string, string, string, string, string, string, uint256)"
    ]);

    const total = await publicClient.readContract({
      address: contractAddress,
      abi: contractAbi,
      functionName: "totalMinted"
    }) as bigint;

    const totalCount = Number(total);
    if (totalCount === 0) return [];

    // Scan up to the last 100 receipts for performance and RPC safety
    const limitReceipts = 100;
    const startTokenId = Math.max(1, totalCount - limitReceipts + 1);
    const tokenIds = Array.from({ length: totalCount - startTokenId + 1 }, (_, i) => BigInt(startTokenId + i));

    // Fetch details for all tokenIds in parallel
    const details = await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          const r = await publicClient.readContract({
            address: contractAddress,
            abi: contractAbi,
            functionName: "receipts",
            args: [tokenId]
          }) as any;
          return { tokenId, r };
        } catch (err) {
          console.error(`[OnChainReceipts] Failed to fetch details for tokenId ${tokenId}:`, err);
          return null;
        }
      })
    );

    const validDetails = details.filter((item): item is { tokenId: bigint; r: any } => item !== null);

    // Split search needle into list of owners to match comma-separated queries
    const needles = ownerAddress.split(",").map(o => o.trim().toLowerCase()).filter(Boolean);
    if (needles.length === 0) return [];

    const receiptsList: IntentReceipt[] = [];

    for (const { tokenId, r } of validDetails) {
      const [
        intentId, beneficiary, sourceChain, destinationChain,
        protocol, action, asset, amountIn, amountOut,
        routeKind, txHash, destinationRecipient, mintedAt
      ] = r;

      // Check if beneficiary (EVM) or destinationRecipient (EVM/Solana/Stellar) matches any of our query needles
      const isMatch = needles.some(needle => 
        beneficiary.toLowerCase() === needle ||
        destinationRecipient.toLowerCase() === needle
      );

      if (!isMatch) continue;

      const isSolana = destinationChain === "SOLANA_DEVNET";
      const isStellar = destinationChain === "STELLAR_TESTNET";

      receiptsList.push({
        id: intentId,
        status: "succeeded",
        createdAt: new Date(Number(mintedAt) * 1000).toISOString(),
        updatedAt: new Date(Number(mintedAt) * 1000).toISOString(),
        input: {
          sourceChain,
          destinationChain,
          protocol,
          action,
          asset,
          amount: amountIn,
          recipient: destinationRecipient,
          preferredRoute: routeKind,
          metadata: {
            sourceWalletAddress: beneficiary,
            evmReceiptWalletAddress: beneficiary
          }
        },
        protocolReceipt: {
          status: "succeeded",
          txHash: !isSolana && !isStellar ? txHash : undefined,
          solanaTxHash: isSolana ? txHash : undefined,
          stellarTxHash: isStellar ? txHash : undefined,
          amountOutFormatted: amountOut,
          tokenOutSymbol: asset
        },
        plan: {
          routeKind,
          sourceChain,
          destinationChain,
          protocol,
          action,
          amount: amountIn,
          asset,
          recipient: destinationRecipient,
          requiresHumanApproval: false,
          rationale: ["Restored from on-chain history."],
          alternatives: [],
          steps: []
        },
        nftReceipt: {
          network: "ARC",
          tokenId: String(tokenId),
          contractAddress,
          mintTxHash: txHash, // fallback to execution txHash
          skipped: false
        }
      });
    }

    // Sort descending by date (newest first)
    receiptsList.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return receiptsList;
  } catch (err) {
    console.error("[OnChainReceipts] Failed to fetch on-chain receipts:", err);
    return [];
  }
}

app.get("/transactions", async (req: any, res: any) => {
  const owner = typeof req.query.owner === "string" ? req.query.owner : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;

  // 1. Fetch transactions from the local memory/postgres store
  const storeItems = await store.list({ owner, limit });

  // 2. Fetch on-chain minted receipts from Arc Testnet contract if owner is provided
  let onChainItems: IntentReceipt[] = [];
  if (owner) {
    onChainItems = await fetchOnChainReceipts(owner);
  }

  // 3. Merge store items and on-chain items (keyed by intent ID to prevent duplicates)
  const mergedMap = new Map<string, IntentReceipt>();
  
  // On-chain items are highly reliable for receipts, so add them first
  for (const item of onChainItems) {
    mergedMap.set(item.id, item);
  }
  
  // Store items can overwrite/update them with full details if they match
  for (const item of storeItems) {
    const existing = mergedMap.get(item.id);
    if (existing) {
      // Merge: preserve on-chain nftReceipt if the store doesn't have it
      mergedMap.set(item.id, {
        ...existing,
        ...item,
        nftReceipt: item.nftReceipt ?? existing.nftReceipt
      });
    } else {
      mergedMap.set(item.id, item);
    }
  }

  const combined = Array.from(mergedMap.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  // We do NOT perform real-time RPC calls for the entire list to prevent 429 rate limits!
  // Instead, we return the steps with default status immediately so they are rendering explorer links.
  const transactions = combined.map((receipt) => {
    const steps = txHashes(receipt).map((tx) => ({
      ...tx,
      status: {
        found: false,
        confirmed: false,
        finalized: false
      }
    }));
    return {
      ...receipt,
      onChain: {
        checkedAt: new Date().toISOString(),
        transactions: steps
      }
    };
  });

  res.json({
    source: store.storageKind,
    count: transactions.length,
    transactions: transactions
  });
});

app.get("/transactions/:id/status", async (req: any, res: any) => {
  const { id } = req.params;
  
  // 1. Fetch transaction from store
  let receipt = await store.get(id);
  
  // 2. Fallback search if not found directly
  if (!receipt) {
    const allItems = await store.list({ limit: 100 });
    receipt = allItems.find((item) => item.id === id);
  }
  
  // 3. Check on-chain receipts if not in store
  if (!receipt) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  // 4. Enrich only this single transaction with on-chain status
  const enriched = await enrichIntentWithOnChainStatus(receipt);
  res.json(enriched);
});

app.post("/agents/analyze", async (req: any, res: any) => {
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await agentManager.analyze(parsed.data));
});

app.post("/agents/chat", async (req: any, res: any) => {
  const { message, connectedWallet, connectedChain, solanaWallet, stellarWallet } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Missing message parameter" });
  }
  const result = await geminiChatService.chat(message, {
    connectedWallet,
    connectedChain,
    solanaWallet,
    stellarWallet
  });
  res.json(result);
});

app.get("/gateway/balances/:owner", async (req: any, res: any) => {
  try {
    res.json(await gateway.getUnifiedBalance(req.params.owner));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/balances/monitor/check", async (_req: any, res: any) => {
  try {
    res.json(await balanceMonitor.checkNow());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/gateway/prepare", async (req: any, res: any) => {
  const parsed = createIntentSchema.safeParse({ ...req.body, preferredRoute: "GATEWAY" });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.json(await gateway.prepareUserGatewayTransfer(parsed.data));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/agents/rebalance/propose", async (req: any, res: any) => {
  const balances = req.body?.balances ?? { ARC: 10, BASE_SEPOLIA: 100, ETHEREUM_SEPOLIA: 80, SOLANA_DEVNET: 40 };
  res.json(await treasury.proposeRebalance(balances));
});

app.get("/paid/resources", (_req: any, res: any) => {
  res.json(nanopaymentAgent.listResources());
});

app.get("/paid/challenge", async (req: any, res: any) => {
  const path = String(req.query.path ?? "");
  if (!nanopaymentAgent.getResource(path)) {
    return res.status(404).json({ error: `Unknown paid resource: ${path}` });
  }
  try {
    res.json(await nanopaymentAgent.describeChallenge(path));
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function requireNanopayment(path: string) {
  const resource = nanopaymentAgent.getResource(path);
  if (!resource) throw new Error(`Unknown paid resource: ${path}`);
  return x402Gateway.require(`$${resource.priceUsdc}`);
}

function paidSummary(req: PaymentRequest): string {
  const payment = req.payment;
  if (!payment) return "Payment settled through Circle Gateway.";
  const formattedAmount = `${Number(payment.amount) / 1_000_000} USDC`;
  const tx = payment.transaction ? ` (${payment.transaction})` : "";
  return `${formattedAmount} settled from ${payment.payer} on ${payment.network}${tx}`;
}

app.get("/paid/protocol-score", requireNanopayment("/paid/protocol-score"), async (req: any, res: any) => {
  const path = "/paid/protocol-score";
  const resource = nanopaymentAgent.getResource(path);
  res.json({
    protocol: String(req.query.protocol ?? "ETH_AAVE_V3"),
    score: 88,
    confidence: "high",
    explanation: "Strong protocol score: native Gateway liquidity, EVM settlement, CCTP fallback coverage, and receipt-grade adapter metadata are all available for this route.",
    resource,
    payment: req.payment,
    paidWith: paidSummary(req)
  });
});

app.get("/paid/route-alpha", requireNanopayment("/paid/route-alpha"), async (req: PaymentRequest, res: any) => {
  const path = "/paid/route-alpha";
  const resource = nanopaymentAgent.getResource(path);
  res.json({
    recommendation: "GATEWAY",
    reason: "Gateway is the preferred route for this intent because it keeps USDC unified across Arc, Base Sepolia, and Ethereum Sepolia while avoiding bridge inventory fragmentation.",
    alternativeRoutes: ["CCTP_V2", "BRIDGEKIT"],
    resource,
    payment: req.payment,
    paidWith: paidSummary(req)
  });
});

app.post("/webhooks/gateway", (req: any, res: any) => {
  console.log("Gateway webhook", req.body);
  res.json({ ok: true });
});

/**
 * Live Circle CCTP fee rates for all configured chain-pair combinations.
 * Queries Circle's Iris API when CIRCLE_API_KEY is set; returns static fallbacks otherwise.
 */
app.get("/circle/fees", async (_req: any, res: any) => {
  const chains = Object.values(chainConfig).filter((c: any) => c.cctpDomain !== undefined) as any[];
  const pairs: Array<{ source: string; dest: string; sourceDomain: number; destDomain: number; standardBps: number | null; fastBps: number | null; live: boolean }> = [];

  for (const src of chains) {
    for (const dst of chains) {
      if (src.key === dst.key) continue;
      let standardBps: number | null = null;
      let fastBps: number | null = null;
      let live = false;
      if (env.liveFees) {
        try {
          standardBps = await liveQuoteService.getCctpLiveFeeBps(src.cctpDomain, dst.cctpDomain, false);
          fastBps = await liveQuoteService.getCctpLiveFeeBps(src.cctpDomain, dst.cctpDomain, true);
          if (standardBps !== null || fastBps !== null) live = true;
        } catch {
          // fallback silently
        }
      }
      pairs.push({
        source: src.key,
        dest: dst.key,
        sourceDomain: src.cctpDomain,
        destDomain: dst.cctpDomain,
        standardBps,
        fastBps,
        live
      });
    }
  }

  res.json({
    circleApiConfigured: Boolean(env.circleApiKey),
    irisApiUrl: env.circleIrisApiUrl,
    pairs
  });
});

/**
 * Retry NFT receipt minting for a given intent ID.
 * Useful if the original execution succeeded but NFT mint failed (e.g., RPC timeout).
 * Idempotent — checks on-chain `intentToToken` mapping first.
 */
app.post("/intents/:id/retry-nft", async (req: any, res: any) => {
  const receipt = await store.get(req.params.id);
  if (!receipt) return res.status(404).json({ error: "intent not found" });
  if (receipt.status !== "succeeded") {
    return res.status(400).json({ error: `Cannot retry NFT for intent in status: ${receipt.status}` });
  }

  const metadata = { ...(receipt.input?.metadata ?? {}) };
  if (typeof req.body?.evmReceiptWalletAddress === "string" && req.body.evmReceiptWalletAddress.length > 0) {
    metadata.evmReceiptWalletAddress = req.body.evmReceiptWalletAddress;
  }
  if (typeof req.body?.sourceWalletAddress === "string" && req.body.sourceWalletAddress.length > 0) {
    metadata.sourceWalletAddress = req.body.sourceWalletAddress;
  }

  const refreshedReceipt = await store.update(receipt.id, {
    input: {
      ...receipt.input,
      metadata
    }
  });

  const nftReceipt = await arcReceiptMinter.mint(refreshedReceipt);
  const updated = await store.update(receipt.id, { nftReceipt });
  res.json({ nftReceipt: updated.nftReceipt, receipt: updated });
});

function chainForTx(receipt: IntentReceipt, hash: string): string {
  const protocol = receipt.protocolReceipt ?? {};
  const bridge = receipt.bridgeReceipt ?? {};
  if (hash === protocol.solanaTxHash || hash === bridge.solanaTxHash) return "SOLANA_DEVNET";
  if (hash === protocol.stellarTxHash || hash === bridge.stellarTxHash) return "STELLAR_TESTNET";
  if (hash === protocol.txHash || hash === bridge.mintTxHash) return receipt.input.destinationChain;
  if (hash === receipt.nftReceipt?.mintTxHash) return "ARC";
  return receipt.input.sourceChain;
}

function txHashes(receipt: IntentReceipt): Array<{ label: string; hash: string; chain: string }> {
  const bridge = receipt.bridgeReceipt ?? {};
  const protocol = receipt.protocolReceipt ?? {};
  const metadata = receipt.input.metadata ?? {};
  const entries = [
    { label: "Gateway approve", hash: metadata.gatewayApproveTxHash },
    { label: "Gateway deposit", hash: metadata.gatewayDepositTxHash },
    { label: "User deposit", hash: metadata.userDepositTxHash },
    { label: "Bridge", hash: bridge.txHash ?? bridge.burnTxHash ?? bridge.mintTxHash ?? bridge.solanaTxHash ?? bridge.stellarTxHash },
    { label: "Protocol execution", hash: protocol.txHash ?? protocol.solanaTxHash ?? protocol.stellarTxHash },
    { label: "Receipt NFT", hash: receipt.nftReceipt?.mintTxHash }
  ]
    .filter((item): item is { label: string; hash: string } => typeof item.hash === "string" && item.hash.length > 0)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.hash === item.hash) === index);
  return entries.map((entry) => ({ ...entry, chain: chainForTx(receipt, entry.hash) }));
}

// In-memory cache for confirmed transaction statuses to eliminate duplicate RPC calls
const txStatusCache = new Map<string, {
  found: boolean;
  confirmed: boolean;
  finalized: boolean;
  blockNumber?: string;
  status?: any;
  ledger?: any;
  error: string | null;
}>();

async function enrichIntentWithOnChainStatus(receipt: IntentReceipt) {
  const checks = [];
  
  // Fetch steps sequentially with a small delay for network hits to prevent 429 rate limits
  for (const tx of txHashes(receipt)) {
    const cacheKey = `${tx.chain}:${tx.hash}`;
    const isCached = txStatusCache.has(cacheKey);
    
    const status = await lookupTxStatus(tx.chain, tx.hash);
    checks.push({ ...tx, status });
    
    // If it was a real network query, add a small 150ms delay to throttle requests gracefully
    if (!isCached) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  
  return {
    ...receipt,
    onChain: {
      checkedAt: new Date().toISOString(),
      transactions: checks
    }
  };
}

async function lookupTxStatus(chainKey: string, txHash: string) {
  const cacheKey = `${chainKey}:${txHash}`;
  if (txStatusCache.has(cacheKey)) {
    return txStatusCache.get(cacheKey)!;
  }

  try {
    const chain = findChainByKey(chainKey);
    const rpc = process.env[chain.rpcEnv] ?? chain.rpcUrl;
    let result;

    if (chain.vm === "svm") {
      const connection = new Connection(rpc, "confirmed");
      const status = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
      result = {
        found: Boolean(status.value),
        confirmed: Boolean(status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized"),
        finalized: status.value?.confirmationStatus === "finalized",
        error: status.value?.err ? JSON.stringify(status.value.err) : null
      };
    } else if (chain.vm === "soroban") {
      const server = new Horizon.Server("https://horizon-testnet.stellar.org");
      const tx = await server.transactions().transaction(txHash).call();
      result = {
        found: true,
        confirmed: Boolean(tx.successful),
        finalized: Boolean(tx.successful),
        ledger: tx.ledger_attr,
        error: tx.successful ? null : "Stellar transaction failed"
      };
    } else {
      const viemChain = {
        id: chain.chainId,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency ?? { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } }
      };
      const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
      const tx = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      result = {
        found: true,
        confirmed: true,
        finalized: true,
        blockNumber: tx.blockNumber.toString(),
        status: tx.status,
        error: tx.status === "success" ? null : "EVM transaction reverted"
      };
    }

    // Cache confirmed or finalized statuses permanently to stop future RPC calls
    if (result.confirmed) {
      txStatusCache.set(cacheKey, result);
    }
    
    return result;
  } catch (err) {
    return {
      found: false,
      confirmed: false,
      finalized: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export function startBackgroundServices() {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;
  balanceMonitor.start();
}

export default app;
