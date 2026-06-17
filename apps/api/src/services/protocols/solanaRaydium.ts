import { env, findProtocol } from "../../config/index.js";
import { parseUnitsDecimal } from "../../utils/amounts.js";
import { resolveSolanaAdapterPayload } from "./nonEvmPayloads.js";
import { simulateSolanaAdapter, submitSolanaAdapter } from "./solanaAdapterSubmitter.js";
import { solanaLamportsFeeLine, sumFeeLinesUsd } from "../fees/transactionFeeUtils.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { findChainByKey } from "../../config/index.js";

export interface RaydiumAdapterAction {
  intentId?: string;
  action?: "SwapBaseInput" | "SwapBaseOutput" | "Deposit" | "Withdraw" | "InitializePool";
  amount?: string;
  amountRaw?: string;
  executionAmount?: string;
  amountIn?: string;
  amountInRaw?: string;
  limitAmount?: string;
  limitAmountRaw?: string;
  cpiDataBase64?: string;
  remainingAccounts?: Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }>;
  sdkInstruction?: unknown;
  instruction?: unknown;
  allowSyntheticTestPayload?: boolean;
  computeUnitLimit?: number | string;
  computeUnitPriceMicroLamports?: number | string;
  memo?: string;
  simulateOnly?: boolean;
}

export class RaydiumService {
  async buildAndMaybeSubmit(action: RaydiumAdapterAction): Promise<Record<string, unknown>> {
    const protocol = findProtocol("SOL_RAYDIUM_CPMM");
    const adapterProgramId = env.solanaRaydiumAdapterProgramId || protocol.adapterProgramId;
    const selectedAction = normalizeRaydiumAction(action.action);
    const payload = resolveSolanaAdapterPayload({
      action: selectedAction,
      protocolProgramId: protocol.programId,
      providedCpiDataBase64: action.cpiDataBase64,
      providedRemainingAccounts: action.remainingAccounts,
      sdkInstruction: action.sdkInstruction,
      instruction: action.instruction,
      allowSyntheticTestPayload: action.allowSyntheticTestPayload
    });
    let resolvedCpiDataBase64 = payload?.cpiDataBase64 ?? action.cpiDataBase64;
    let resolvedRemainingAccounts = payload?.remainingAccounts ?? action.remainingAccounts;

    if ((!resolvedCpiDataBase64 || !resolvedRemainingAccounts?.length)) {
      try {
        const chain = findChainByKey("SOLANA_DEVNET");
        const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
        const connection = new Connection(rpcUrl, "confirmed");
        
        const poolIdStr = action.memo?.split("pool:")[1] || "";
        if (poolIdStr && poolIdStr.length > 30) {
           const owner = new PublicKey("11111111111111111111111111111111");
           const raydium = await Raydium.load({
             connection,
             owner,
             disableFeatureCheck: true
           });
           
           try {
             const poolInfo = await raydium.cpmm.getRpcPoolInfo(poolIdStr);
              const swapResult = await (raydium.cpmm as any).swapBaseIn({
                poolInfo,
                swapResult: { sourceAmountSwapped: true, destinationAmountSwapped: true } as any,
                ownerInfo: { useSOLBalance: true },
              });
              const ix = swapResult.builder.instruction();
              
              resolvedCpiDataBase64 = Buffer.from(ix.data).toString("base64");
              resolvedRemainingAccounts = ix.keys.map((k: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }) => ({
                pubkey: k.pubkey.toBase58(),
                isWritable: k.isWritable,
                isSigner: k.isSigner
              }));
           } catch (poolErr) {
             console.warn("Raydium pool lookup failed:", poolErr);
           }
        }
      } catch (err) {
        console.error("Raydium SDK builder failed:", err);
      }
      if (!resolvedCpiDataBase64 || !resolvedRemainingAccounts?.length) {
        throw new Error("Raydium live execution requires a real pool id or SDK/provided CPI payload; synthetic CPI payloads are disabled.");
      }
    }

    const isConfigured = Boolean(adapterProgramId && resolvedCpiDataBase64 && resolvedRemainingAccounts?.length);
    const adapterInvocation = {
      programId: adapterProgramId,
      instruction: "execute",
      accounts: [
        { name: "config", pdaSeeds: ["raydium-config"] },
        { name: "receipt", pdaSeeds: ["raydium-receipt", action.intentId ?? "<intent-id-bytes32>"] },
        { name: "authority", signer: true, writable: true },
        { name: "raydiumProgram", pubkey: protocol.programId },
        { name: "systemProgram", pubkey: "11111111111111111111111111111111" },
        { name: "remainingAccounts", source: "Raydium SDK pool/account resolver", value: resolvedRemainingAccounts ?? [] }
      ],
      args: {
        intentId: action.intentId ?? "<intent-id-bytes32>",
        action: selectedAction,
        amountIn: action.amountInRaw ?? action.amountIn ?? action.amountRaw ?? action.executionAmount ?? action.amount ?? "0",
        limitAmount: action.limitAmountRaw ?? action.limitAmount ?? "0",
        cpiDataBase64: resolvedCpiDataBase64 ?? "<serialized Raydium Anchor instruction data>",
        memo: action.memo ?? "Chrysalis V2 Raydium intent"
      }
    };

    if (action.simulateOnly && isConfigured) {
      const result = await simulateSolanaAdapter({
        protocol: "raydium",
        adapterProgramId,
        protocolProgramId: protocol.programId,
        intentId: action.intentId ?? "simulation",
        actionIndex: RAYDIUM_ACTION_INDEX[selectedAction],
        amount: rawAmount(action.amountInRaw ?? action.amountIn ?? action.amountRaw ?? action.executionAmount ?? action.amount, 6),
        limitAmount: rawAmount(action.limitAmountRaw ?? action.limitAmount, 6),
        cpiDataBase64: resolvedCpiDataBase64!,
        remainingAccounts: resolvedRemainingAccounts!,
        memo: action.memo ?? "Chrysalis V2 Raydium intent",
        computeUnitLimit: numberFromAction(action.computeUnitLimit),
        computeUnitPriceMicroLamports: numberFromAction(action.computeUnitPriceMicroLamports)
      });
      return {
        status: "simulated",
        executable: true,
        chain: "SOLANA_DEVNET",
        protocol: protocol.key,
        protocolProgramId: protocol.programId,
        adapterProgramId,
        adapter: protocol.adapter,
        simulation: result,
        adapterInvocation
      };
    }

    if (!env.agentDryRun && isConfigured) {
      try {
        const result = await submitSolanaAdapter({
          protocol: "raydium",
          adapterProgramId,
          protocolProgramId: protocol.programId,
          intentId: action.intentId ?? "",
          actionIndex: RAYDIUM_ACTION_INDEX[selectedAction],
          amount: rawAmount(action.amountInRaw ?? action.amountIn ?? action.amountRaw ?? action.executionAmount ?? action.amount, 6),
          limitAmount: rawAmount(action.limitAmountRaw ?? action.limitAmount, 6),
          cpiDataBase64: resolvedCpiDataBase64!,
          remainingAccounts: resolvedRemainingAccounts!,
          memo: action.memo ?? "Chrysalis V2 Raydium intent",
          computeUnitLimit: numberFromAction(action.computeUnitLimit),
          computeUnitPriceMicroLamports: numberFromAction(action.computeUnitPriceMicroLamports)
        });
        const feeLines = result.feeLamports && result.signature
          ? [await solanaLamportsFeeLine({
              label: "Raydium Solana execution",
              feeLamports: result.feeLamports,
              txHash: result.signature,
              payer: "developer"
            })]
          : [];

        return {
          status: result.signature ? "succeeded" : "already_executed",
          executable: true,
          chain: "SOLANA_DEVNET",
          protocol: protocol.key,
          protocolProgramId: protocol.programId,
          adapterProgramId,
          adapter: protocol.adapter,
          solanaTxHash: result.signature || undefined,
          receiptPda: result.receiptPda,
          feeLines,
          actualFeeUsd: sumFeeLinesUsd(feeLines),
          adapterInvocation
        };
      } catch (err) {
        return {
          status: "failed",
          executable: true,
          chain: "SOLANA_DEVNET",
          protocol: protocol.key,
          adapterProgramId,
          adapter: protocol.adapter,
          adapterInvocation,
          note: err instanceof Error ? err.message : String(err)
        };
      }
    }

    return {
      status: env.agentDryRun ? "planned" : isConfigured ? "builder_only" : "not_configured",
      chain: "SOLANA_DEVNET",
      protocol: protocol.key,
      protocolProgramId: protocol.programId,
      adapterProgramId,
      adapter: protocol.adapter,
      executable: false,
      adapterInvocation,
      safetyChecks: [
        "adapter validates Raydium CPMM/CP-Swap program id",
        "adapter validates allowed Raydium Anchor discriminator for selected action",
        "adapter records an on-chain receipt PDA after successful CPI"
      ],
      note: isConfigured
        ? `Raydium adapter payload built. Action: ${selectedAction}. ${env.agentDryRun ? "AGENT_DRY_RUN enabled — transaction not submitted." : "Transaction submitted to devnet."}`
        : "Raydium live execution is not configured. Resolve pool state, vaults, amm config, observation/oracle accounts, slippage, cpiDataBase64, and remaining accounts with the Raydium SDK before submitting."
    };
  }
}

const RAYDIUM_ACTION_INDEX: Record<NonNullable<RaydiumAdapterAction["action"]>, number> = {
  SwapBaseInput: 0,
  SwapBaseOutput: 1,
  Deposit: 2,
  Withdraw: 3,
  InitializePool: 4
};

function normalizeRaydiumAction(action: unknown): NonNullable<RaydiumAdapterAction["action"]> {
  if (action === "SwapBaseOutput" || action === "Deposit" || action === "Withdraw" || action === "InitializePool") return action;
  return "SwapBaseInput";
}

function rawAmount(value: unknown, decimals: number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && /^[0-9]+$/.test(value) && value.length > decimals) return BigInt(value);
  if (typeof value === "string" && value.trim()) return parseUnitsDecimal(value, decimals);
  return 0n;
}

function numberFromAction(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return undefined;
}
