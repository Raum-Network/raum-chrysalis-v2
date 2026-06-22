import express from "express";
import cors from "cors";
import { createGatewayMiddleware, type PaymentRequest } from "@circle-fin/x402-batching/server";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import { env, chainConfig, protocolConfig, protocolGroupForChainKey, hasGatewayContracts, hasCctpEvmContracts } from "./config/index.js";
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

app.get("/intents", (_req: any, res: any) => {
  res.json(store.list());
});

app.get("/intents/:id", (req: any, res: any) => {
  const item = store.get(req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
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
  const receipt = store.get(req.params.id);
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

  const refreshedReceipt = store.update(receipt.id, {
    input: {
      ...receipt.input,
      metadata
    }
  });

  const nftReceipt = await arcReceiptMinter.mint(refreshedReceipt);
  const updated = store.update(receipt.id, { nftReceipt });
  res.json({ nftReceipt: updated.nftReceipt, receipt: updated });
});

export function startBackgroundServices() {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;
  balanceMonitor.start();
}

export default app;
