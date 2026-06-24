import { nanoid } from "nanoid";
import { z } from "zod";
import { createPublicClient, http, Hex, parseAbi } from "viem";
import { Connection } from "@solana/web3.js";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { agentManager } from "../agents/AgentManager.js";
import { JudgeNarratorAgent } from "../agents/JudgeNarratorAgent.js";
import { env, findChainByKey } from "../config/index.js";

import { GatewayService } from "../services/bridge/gatewayService.js";
import { CctpService } from "../services/bridge/cctpService.js";
import { ProtocolExecutorRegistry } from "../services/protocols/ProtocolExecutorRegistry.js";
import { arcReceiptMinter } from "../services/receipts/arcReceiptMinter.js";
import { CircleBridgeKitService } from "../services/bridge/circleBridgeKit.js";
import { store } from "../store/memory.js";
import { CreateIntentInput, FeeLineItem, IntentReceipt, RoutePlan } from "../types.js";
import { formatUnitsDecimal, parseUnitsDecimal } from "../utils/amounts.js";
import {
  evmTransactionFeeLine,
  solanaTransactionFeeLine,
  stellarStroopsFeeLine,
  sumFeeLinesUsd
} from "../services/fees/transactionFeeUtils.js";

const erc20BalanceAbi = parseAbi([
  "function balanceOf(address account) external view returns (uint256)"
]);

export const createIntentSchema = z.object({
  sourceChain: z.string().min(1),
  destinationChain: z.string().min(1),
  asset: z.enum(["USDC", "EURC"]),
  amount: z.string().min(1),
  protocol: z.string().min(1),
  action: z.string().min(1),
  autonomous: z.boolean().optional(),
  approved: z.boolean().optional(),
  quoteOnly: z.boolean().optional(),
  preflightOnly: z.boolean().optional(),
  slippageBps: z.number().int().min(0).max(10_000).optional(),
  recipient: z.string().optional(),
  clientIntentId: z.string().min(1).max(128).optional(),
  preferredRoute: z.enum(["GATEWAY", "BRIDGEKIT", "CCTP_V2", "LOCAL", "MOCK"]).optional(),
  optimizationGoal: z.enum(["balanced", "lowest_cost", "fastest", "safest"]).optional(),
  maxTotalFeeUsd: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

type ParsedIntent = CreateIntentInput & { approved?: boolean; quoteOnly?: boolean };

export class IntentOrchestrator {

  private gateway = new GatewayService();
  private cctp = new CctpService();
  private bridgeKit = new CircleBridgeKitService();
  private executor = new ProtocolExecutorRegistry();
  private narrator = new JudgeNarratorAgent();

  async createAndRun(input: CreateIntentInput): Promise<IntentReceipt> {
    const parsed = createIntentSchema.parse(input) as ParsedIntent;
    const now = new Date().toISOString();
    const id = nanoid();
    let receipt = await store.create({ id, input: parsed, status: "created", createdAt: now, updatedAt: now });

    try {
      const analysis = await agentManager.analyze(parsed);
      const quoteOnly = parsed.quoteOnly === true || parsed.preflightOnly === true;
      const awaitingApproval = analysis.plan.requiresHumanApproval && parsed.approved !== true;
      const blockedByPolicy = !analysis.policy.allowed || analysis.plan.routeKind === "MOCK";
      const plan = parsed.approved === true && !blockedByPolicy
        ? this.markPlanApproved(analysis.plan)
        : analysis.plan;
      const approvedAnalysis = { ...analysis, plan };
      receipt = await store.update(id, {
        status: quoteOnly ? "quoted" : awaitingApproval || blockedByPolicy ? "needs_approval" : "planned",
        plan
      });

      if (quoteOnly || awaitingApproval || blockedByPolicy) {
        const aiNarration = this.narrator.narrate(receipt);
        return store.update(id, { aiNarration });
      }

      // Execute the bridging, protocol execution, and minting asynchronously in the background
      this.runExecutionPipeline(id, approvedAnalysis);

      return receipt;
    } catch (err) {
      return store.update(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private markPlanApproved(plan: RoutePlan): RoutePlan {
    return {
      ...plan,
      requiresHumanApproval: false,
      rationale: [
        ...plan.rationale.filter((item) => item !== "Human approval is required by policy before execution."),
        "User approval was provided, so execution is authorized."
      ],
      intentDecision: plan.intentDecision
        ? { ...plan.intentDecision, approvalRequired: false }
        : plan.intentDecision
    };
  }

  async runExecutionPipeline(id: string, analysis: any) {
    try {
      let receipt = await store.get(id);
      if (!receipt) return;

      let sourceMetadataFeeLines: FeeLineItem[] = [];
      try {
        sourceMetadataFeeLines = await this.collectSourceMetadataFeeLines(receipt);
      } catch (txErr) {
        console.error(`[Orchestrator] Error verifying source metadata transactions:`, txErr);
        await store.update(id, {
          status: "failed",
          error: `Source transaction verification failed: ${txErr instanceof Error ? txErr.message : String(txErr)}`
        });
        return;
      }

      const dstChain = findChainByKey(analysis.plan.destinationChain);
      const dstVm = dstChain.vm as string;
      const isNonEvmDestination = dstVm !== "evm";
      const isBridgeOnly = analysis.plan.protocol.endsWith("_USDC_TRANSFER");

      let destinationBalanceBeforeBridge = 0n;
      if (!isNonEvmDestination && !isBridgeOnly) {
        destinationBalanceBeforeBridge = await this.getDestinationRouterUsdcBalance(analysis.plan.destinationChain);
      }

      let bridgeReceipt: any;
      receipt = await store.update(id, { status: "bridging" });
      if (analysis.plan.routeKind === "LOCAL") {
        bridgeReceipt = { status: "skipped", reason: "Local route: no bridge step required." };
      } else if (analysis.plan.routeKind === "GATEWAY") {
        bridgeReceipt = await this.gateway.executeGatewayMint(analysis.plan, receipt.input.metadata);
      } else if (analysis.plan.routeKind === "BRIDGEKIT") {
        bridgeReceipt = await this.bridgeKit.bridge(analysis.plan);
      } else if (analysis.plan.routeKind === "CCTP_V2") {
        bridgeReceipt = await this.cctp.executeBridge(analysis.plan);
      } else {
        bridgeReceipt = await this.cctp.executeBridge(analysis.plan);
      }

      const bridgeFeeLines = [
        ...sourceMetadataFeeLines,
        ...this.feeLinesFrom(bridgeReceipt)
      ];
      if (bridgeFeeLines.length > 0) {
        bridgeReceipt = {
          ...bridgeReceipt,
          feeLines: bridgeFeeLines,
          actualFeeUsd: sumFeeLinesUsd(bridgeFeeLines)
        };
      }

      // If bridge failed, stop — the router has no USDC to execute with
      const bridgeStatus = String(bridgeReceipt.status ?? "");
      const bridgeFailed = ["bridge_failed", "bridge_skipped", "failed", "bridge_pending"].includes(bridgeStatus);
      if (bridgeFailed) {
        const reason = String(bridgeReceipt.reason ?? bridgeReceipt.stellarMessage ?? bridgeReceipt.solanaMessage ?? bridgeReceipt.message ?? "Bridge step failed.");
        console.error(`[Orchestrator] Bridge failed (${bridgeStatus}): ${reason}`);
        await store.update(id, {
          bridgeReceipt,
          status: "failed",
          error: `Bridge failed: ${reason}`
        });
        return;
      }

      if (analysis.plan.routeKind !== "LOCAL") {
        if (isNonEvmDestination || isBridgeOnly) {
          analysis.plan = {
            ...analysis.plan,
            executionAmount: analysis.plan.amount
          };
          bridgeReceipt = {
            ...bridgeReceipt,
            destinationChain: analysis.plan.destinationChain,
            destinationRouterAmountReceived: parseUnitsDecimal(analysis.plan.amount, 6).toString(),
            destinationRouterAmountReceivedUsdc: analysis.plan.amount
          };
        } else {
          const executionAmount = await this.waitForDestinationRouterFunding(
            analysis.plan.destinationChain,
            destinationBalanceBeforeBridge,
            parseUnitsDecimal(analysis.plan.amount, 6)
          );
          analysis.plan = {
            ...analysis.plan,
            executionAmount: formatUnitsDecimal(executionAmount, 6)
          };
          bridgeReceipt = {
            ...bridgeReceipt,
            destinationChain: analysis.plan.destinationChain,
            destinationRouterAmountReceived: executionAmount.toString(),
            destinationRouterAmountReceivedUsdc: formatUnitsDecimal(executionAmount, 6)
          };
        }
      }

      receipt = await store.update(id, { bridgeReceipt, status: "executing" });
      const actionPayload = {
        ...analysis.actionPayload,
        serviceAction: {
          ...(analysis.actionPayload.serviceAction ?? {}),
          intentId: id,
          recipient: analysis.plan.recipient,
          executionAmount: analysis.plan.executionAmount,
          memo: `Chrysalis V2 intent ${id}`
        }
      };
      const protocolReceipt = await this.executor.execute(analysis.plan, actionPayload);

      // Check if protocol execution actually succeeded on-chain
      const protocolStatus = String(protocolReceipt.status ?? "");
      const protocolTxHash = protocolReceipt.txHash ?? protocolReceipt.stellarTxHash ?? protocolReceipt.solanaTxHash;
      if (
        protocolStatus === "not_deployed" ||
        protocolStatus === "not_configured" ||
        protocolStatus === "failed" ||
        protocolStatus === "builder_only" ||
        (protocolReceipt.executable === false && !protocolTxHash)
      ) {
        const msg = String(protocolReceipt.note ?? "Protocol execution was not submitted on-chain.");
        await store.update(id, { protocolReceipt, bridgeReceipt, status: "failed", error: msg });
        return;
      }

      receipt = await store.update(id, { protocolReceipt, status: "finalizing" });

      // Mint on-chain receipt NFT on Arc Testnet (best-effort, but record the outcome before success).
      const nftReceipt = await arcReceiptMinter.mint(receipt);
      const actualFeeLines = [
        ...this.feeLinesFrom(bridgeReceipt),
        ...this.feeLinesFrom(protocolReceipt),
        ...this.feeLinesFrom(nftReceipt)
      ];
      receipt = await store.update(id, {
        nftReceipt,
        actualFeeLines,
        actualFeeUsd: sumFeeLinesUsd(actualFeeLines),
        status: "succeeded"
      });

      const aiNarration = this.narrator.narrate(receipt);
      await store.update(id, { aiNarration });
    } catch (err) {
      console.error(`[Orchestrator] Background execution failed:`, err);
      await store.update(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async getDestinationRouterUsdcBalance(chainKey: string): Promise<bigint> {
    const chain = findChainByKey(chainKey);
    const routerAddress = chainKey === "ARC" ? env.arcRouterAddress
      : chainKey === "BASE_SEPOLIA" ? env.baseRouterAddress
      : chainKey === "ETHEREUM_SEPOLIA" ? env.ethereumRouterAddress
      : "";
    if (!routerAddress || !chain.tokens?.USDC?.address) return 0n;

    const rpc = process.env[chain.rpcEnv] ?? chain.rpcUrl;
    const viemChain = {
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency ?? { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } }
    };
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    return publicClient.readContract({
      address: chain.tokens.USDC.address as Hex,
      abi: erc20BalanceAbi,
      functionName: "balanceOf",
      args: [routerAddress as Hex]
    });
  }

  private async waitForDestinationRouterFunding(
    chainKey: string,
    balanceBeforeBridge: bigint,
    expectedDelta: bigint
  ): Promise<bigint> {
    if (expectedDelta <= 0n) return 0n;
    const deadline = Date.now() + 30 * 60 * 1000;
    let latestBalance = balanceBeforeBridge;

    while (Date.now() < deadline) {
      latestBalance = await this.getDestinationRouterUsdcBalance(chainKey);
      const receivedForIntent = latestBalance > balanceBeforeBridge ? latestBalance - balanceBeforeBridge : 0n;
      console.log(`[Orchestrator] Destination router USDC on ${chainKey}: before=${formatUnitsDecimal(balanceBeforeBridge, 6)}, current=${formatUnitsDecimal(latestBalance, 6)}, received=${formatUnitsDecimal(receivedForIntent, 6)}, expected=${formatUnitsDecimal(expectedDelta, 6)}`);
      if (receivedForIntent >= expectedDelta) return receivedForIntent;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const received = latestBalance > balanceBeforeBridge ? latestBalance - balanceBeforeBridge : 0n;
    throw new Error(`Bridge funds not available on destination router yet. Expected ${formatUnitsDecimal(expectedDelta, 6)} USDC for this intent, received ${formatUnitsDecimal(received, 6)} USDC after waiting.`);
  }

  private async collectSourceMetadataFeeLines(receipt: IntentReceipt): Promise<FeeLineItem[]> {
    const metadata = receipt.input.metadata ?? {};
    const srcChain = findChainByKey(receipt.input.sourceChain);
    if (srcChain.vm !== "evm" && receipt.input.asset === "USDC") {
      if (typeof metadata.userDepositTxHash !== "string" || metadata.userDepositTxHash.length === 0) {
        throw new Error(`${srcChain.name} source routes require a user-signed USDC deposit before backend execution.`);
      }
    }

    const sourceTxs = [
      { hash: metadata.gatewayApproveTxHash, label: "User Gateway approve" },
      { hash: metadata.gatewayDepositTxHash, label: "User Gateway deposit" },
      { hash: metadata.userDepositTxHash, label: "User source transfer" }
    ].filter((item): item is { hash: string; label: string } => typeof item.hash === "string" && item.hash.length > 0);

    const uniqueTxs = sourceTxs.filter((item, index, all) =>
      all.findIndex((candidate) => candidate.hash.toLowerCase() === item.hash.toLowerCase()) === index
    );
    if (uniqueTxs.length === 0) return [];

    const srcRpc = process.env[srcChain.rpcEnv] ?? srcChain.rpcUrl;
    if (srcChain.vm === "svm") {
      const connection = new Connection(srcRpc, "confirmed");
      const feeLines: FeeLineItem[] = [];
      for (const tx of uniqueTxs) {
        console.log(`[Orchestrator] Verifying Solana source tx: ${tx.label} ${tx.hash}...`);
        const parsed = await connection.getParsedTransaction(tx.hash, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        if (!parsed || parsed.meta?.err) throw new Error(`${tx.label} failed or was not found on Solana: ${tx.hash}`);

        if (tx.hash === metadata.userDepositTxHash) {
          const expectedAmount = parseUnitsDecimal(receipt.input.amount, srcChain.tokens?.USDC?.decimals ?? 6);
          const expectedDestination = String(metadata.solanaOperatorUsdcAccount ?? "");
          const expectedAuthority = String(metadata.sourceWalletAddress ?? metadata.solanaAddress ?? "");
          const transferOk = parsed.transaction.message.instructions.some((ix: any) => {
            const info = ix?.parsed?.info;
            return ix?.program === "spl-token"
              && ix?.parsed?.type === "transfer"
              && String(info?.authority ?? "") === expectedAuthority
              && String(info?.destination ?? "") === expectedDestination
              && BigInt(String(info?.amount ?? "0")) >= expectedAmount;
          });
          if (!transferOk) {
            throw new Error("Solana user deposit transaction does not match the connected wallet, operator USDC account, or required amount.");
          }
        }

        const feeLine = await solanaTransactionFeeLine({
          connection,
          label: tx.label,
          txHash: tx.hash,
          chargedBy: "source_chain",
          payer: "user"
        });
        if (feeLine) feeLines.push(feeLine);
      }
      return feeLines;
    }

    if (srcChain.vm === "soroban") {
      const server = new SorobanRpc.Server(srcRpc);
      const feeLines: FeeLineItem[] = [];
      for (const tx of uniqueTxs) {
        console.log(`[Orchestrator] Verifying Stellar source tx: ${tx.label} ${tx.hash}...`);
        const txResult = await this.waitForStellarSourceTx(server, tx.hash);
        if (txResult.status !== "SUCCESS") throw new Error(`${tx.label} failed or was not found on Stellar: ${tx.hash}`);
        const feeLine = await stellarStroopsFeeLine({
          label: tx.label,
          feeStroops: String(txResult.feeCharged ?? txResult.fee_charged ?? txResult.fee ?? 0),
          txHash: tx.hash,
          chargedBy: "source_chain",
          payer: "user"
        });
        if (feeLine) feeLines.push(feeLine);
      }
      return feeLines;
    }

    const srcViemChain = {
      id: srcChain.chainId,
      name: srcChain.name,
      nativeCurrency: srcChain.nativeCurrency ?? { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [srcRpc] } }
    };
    const publicClient = createPublicClient({ chain: srcViemChain, transport: http(srcRpc) });
    const feeLines: FeeLineItem[] = [];

    for (const tx of uniqueTxs) {
      console.log(`[Orchestrator] Waiting for source tx: ${tx.label} ${tx.hash} on ${receipt.input.sourceChain}...`);
      const txReceipt = await publicClient.waitForTransactionReceipt({ hash: tx.hash as Hex });
      if (txReceipt.status !== "success") {
        throw new Error(`${tx.label} failed on-chain: ${tx.hash}`);
      }
      const feeLine = await evmTransactionFeeLine({
        chainKey: receipt.input.sourceChain,
        label: tx.label,
        txHash: tx.hash,
        chargedBy: "source_chain",
        receipt: txReceipt
      });
      if (feeLine) feeLines.push(feeLine);
    }

    return feeLines;
  }

  private async waitForStellarSourceTx(server: SorobanRpc.Server, txHash: string): Promise<any> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await server.getTransaction(txHash);
      if (result.status !== "NOT_FOUND") return result;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timed out waiting for Stellar source transaction: ${txHash}`);
  }

  private feeLinesFrom(value: unknown): FeeLineItem[] {
    if (!value || typeof value !== "object") return [];
    const maybeLines = (value as { feeLines?: unknown }).feeLines;
    if (!Array.isArray(maybeLines)) return [];
    return maybeLines.filter((line): line is FeeLineItem =>
      Boolean(line && typeof line === "object" && "amountUsd" in line && "currency" in line)
    );
  }
}

export const intentOrchestrator = new IntentOrchestrator();
