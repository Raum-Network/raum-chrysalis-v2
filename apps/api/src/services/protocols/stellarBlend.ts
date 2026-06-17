import { env, findProtocol } from "../../config/index.js";
import { formatUnitsDecimal, parseUnitsDecimal } from "../../utils/amounts.js";
import { resolveStellarAdapterPayload } from "./nonEvmPayloads.js";
import { simulateStellarAdapter, submitStellarAdapter } from "./stellarAdapterSubmitter.js";
import { stellarStroopsFeeLine, sumFeeLinesUsd } from "../fees/transactionFeeUtils.js";
import { Keypair } from "@stellar/stellar-sdk";
import { PoolContractV2, RequestType } from "@blend-capital/blend-sdk";

export interface BlendCapitalAction {
  intentId?: string;
  recipient?: string;
  action?: "supply" | "withdraw" | "borrow" | "repay" | "Supply" | "Withdraw" | "Borrow" | "Repay";
  method?: string;
  targetContractId?: string;
  argsXdr?: string[];
  scVals?: unknown[];
  args?: unknown[];
  amount?: string;
  amountRaw?: string;
  executionAmount?: string;
  asset?: string;
  tokenContract?: string;
  memo?: string;
  simulateOnly?: boolean;
}

const BLEND_TESTNET = {
  dashboardUrl: "https://testnet.blend.capital/dashboard/",
  usdc: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
  xlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  blnd: "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF",
  poolFactoryV2: "CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6",
  backstopV2: "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA",
  defaultPool: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
};

const METHOD_BY_ACTION: Record<string, string> = {
  supply: "submit",
  withdraw: "submit",
  borrow: "submit",
  repay: "submit"
};

export class BlendCapitalService {
  async buildAndMaybeSubmit(action: BlendCapitalAction): Promise<Record<string, unknown>> {
    const protocol = findProtocol("XLM_BLEND");
    const selectedAction = normalizeAction(action.action);
    const targetContract = action.targetContractId
      || env.blendPoolContractId
      || protocol.defaultPool
      || BLEND_TESTNET.defaultPool;
    const method = action.method || METHOD_BY_ACTION[selectedAction] || "submit";
    const payload = resolveStellarAdapterPayload({
      argsXdr: action.argsXdr,
      scVals: action.scVals,
      args: action.args
    });
    let argsXdr = payload?.argsXdr ?? action.argsXdr ?? [];
    const amountRaw = rawOrDecimalAmount(action.amountRaw, action.executionAmount ?? action.amount);
    const tokenContract = resolveBlendToken(protocol, action);
    const caller = env.stellarSecretKey
      ? Keypair.fromSecret(env.stellarSecretKey).publicKey()
      : action.recipient;
    if (!argsXdr.length && caller) {
      argsXdr = buildBlendSubmitArgsXdr({
        caller,
        tokenContract,
        amount: amountRaw,
        action: selectedAction
      });
    }
    const amountFormatted = formatUnitsDecimal(amountRaw, 7);
    const operation = {
      network: "stellar-testnet",
      dashboardUrl: protocol.dashboardUrl ?? BLEND_TESTNET.dashboardUrl,
      adapterContractId: env.blendAdapterContractId || `<${protocol.adapterContractEnv}>`,
      targetContract,
      method,
      action: selectedAction,
      amount: amountRaw.toString(),
      amountFormatted,
      asset: String(action.asset ?? "USDC").toUpperCase(),
      tokenContract,
      poolFactoryV2: env.blendPoolFactoryContractId || protocol.poolFactoryV2 || BLEND_TESTNET.poolFactoryV2,
      backstopV2: env.blendBackstopContractId || protocol.backstopV2 || BLEND_TESTNET.backstopV2,
      argsXdr,
      memo: action.memo ?? "Chrysalis V2 Blend Capital testnet intent"
    };
    const amountOutSymbol = selectedAction === "supply" ? `Blend ${operation.asset} position` : operation.asset;

    if (action.simulateOnly) {
      if (!env.blendAdapterContractId) throw new Error("BLEND_ADAPTER_CONTRACT_ID is not set.");
      if (!argsXdr.length) throw new Error("Blend simulation requires a Stellar signer or Blend submit argsXdr/scVals/native args.");
      const simulation = await simulateStellarAdapter({
        protocol: "blend",
        adapterContractId: env.blendAdapterContractId,
        targetContractId: targetContract,
        targetMethod: method,
        intentId: action.intentId ?? "simulation",
        action: capitalizeAction(selectedAction),
        argsXdr,
        amount: amountRaw,
        memo: action.memo ?? "Chrysalis V2 Blend Capital testnet intent"
      });
      return {
        status: "simulated",
        executable: true,
        chain: "STELLAR_TESTNET",
        protocol: protocol.key,
        adapter: protocol.adapter,
        targetContract,
        executedAmountUsdc: amountFormatted,
        amountOutFormatted: amountFormatted,
        amountOutSymbol,
        receiptTokenSymbol: amountOutSymbol,
        operation,
        simulation
      };
    }

    if (!env.agentDryRun) {
      if (!env.blendAdapterContractId) throw new Error("BLEND_ADAPTER_CONTRACT_ID is not set.");
      if (!argsXdr.length) throw new Error("Blend execution requires a Stellar signer or Blend submit argsXdr/scVals/native args.");
      try {
        const result = await submitStellarAdapter({
          protocol: "blend",
          adapterContractId: env.blendAdapterContractId,
          targetContractId: targetContract,
          targetMethod: method,
          intentId: action.intentId ?? "",
          action: capitalizeAction(selectedAction),
          argsXdr,
          amount: amountRaw,
          memo: action.memo ?? "Chrysalis V2 Blend Capital testnet intent"
        });
        const feeLines = result.feeStroops
          ? [await stellarStroopsFeeLine({
              label: "Blend Stellar execution",
              feeStroops: result.feeStroops,
              txHash: result.hash,
              payer: "developer"
            })]
          : [];
        return {
          status: "succeeded",
          executable: true,
          chain: "STELLAR_TESTNET",
          protocol: protocol.key,
          adapter: protocol.adapter,
          adapterContractId: result.adapterContractId,
          targetContract,
          stellarTxHash: result.hash,
          feeLines,
          actualFeeUsd: sumFeeLinesUsd(feeLines),
          executedAmountUsdc: amountFormatted,
          amountOutFormatted: amountFormatted,
          amountOutSymbol,
          receiptTokenSymbol: amountOutSymbol,
          operation
        };
      } catch (err) {
        return {
          status: "failed",
          executable: true,
          chain: "STELLAR_TESTNET",
          protocol: protocol.key,
          adapter: protocol.adapter,
          adapterContractId: env.blendAdapterContractId,
          targetContract,
          operation,
          note: err instanceof Error ? err.message : String(err)
        };
      }
    }

    return {
      status: env.agentDryRun ? "planned" : "not_configured",
      executable: true,
      chain: "STELLAR_TESTNET",
      protocol: protocol.key,
      adapter: protocol.adapter,
      targetContract,
      executedAmountUsdc: amountFormatted,
      amountOutFormatted: amountFormatted,
      amountOutSymbol,
      receiptTokenSymbol: amountOutSymbol,
      operation,
      note: env.agentDryRun
        ? "Blend Capital testnet route prepared. AGENT_DRY_RUN is enabled, so no live Soroban transaction was submitted."
        : "Set BLEND_ADAPTER_CONTRACT_ID before submitting live Soroban transactions."
    };
  }
}

function buildBlendSubmitArgsXdr(input: {
  caller: string;
  tokenContract: string;
  amount: bigint;
  action: "supply" | "withdraw" | "borrow" | "repay";
}): string[] {
  const requestType = input.action === "withdraw"
    ? RequestType.Withdraw
    : input.action === "borrow"
      ? RequestType.Borrow
      : input.action === "repay"
        ? RequestType.Repay
        : RequestType.Supply;
  return PoolContractV2.spec.funcArgsToScVals("submit", {
    from: input.caller,
    spender: input.caller,
    to: input.caller,
    requests: [{
      request_type: requestType,
      address: input.tokenContract,
      amount: input.amount
    }]
  }).map((value: { toXDR(format: "base64"): string }) => value.toXDR("base64"));
}

function resolveBlendToken(protocol: Record<string, any>, action: BlendCapitalAction): string {
  if (action.tokenContract) return action.tokenContract;
  const symbol = String(action.asset ?? "USDC").toUpperCase();
  return protocol.tokens?.[symbol]
    ?? BLEND_TESTNET[symbol.toLowerCase() as keyof typeof BLEND_TESTNET]
    ?? BLEND_TESTNET.usdc;
}

function capitalizeAction(action: "supply" | "withdraw" | "borrow" | "repay"): "Supply" | "Withdraw" | "Borrow" | "Repay" {
  if (action === "withdraw") return "Withdraw";
  if (action === "borrow") return "Borrow";
  if (action === "repay") return "Repay";
  return "Supply";
}

function normalizeAction(action: unknown): "supply" | "withdraw" | "borrow" | "repay" {
  const normalized = String(action ?? "supply").toLowerCase();
  if (normalized === "withdraw" || normalized === "borrow" || normalized === "repay") return normalized;
  return "supply";
}

function rawAmount(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && value.trim()) return parseUnitsDecimal(value, 7);
  return 0n;
}

function rawOrDecimalAmount(rawValue: unknown, decimalValue: unknown): bigint {
  if (typeof rawValue === "bigint") return rawValue;
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) return BigInt(Math.floor(rawValue));
  if (typeof rawValue === "string" && /^[0-9]+$/.test(rawValue.trim())) return BigInt(rawValue.trim());
  return rawAmount(decimalValue);
}
