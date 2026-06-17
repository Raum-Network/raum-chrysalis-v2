import { createHash } from "node:crypto";
import { createRequire } from "module";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { env, findChainByKey, findProtocol } from "../../config/index.js";
import { parseUnitsDecimal } from "../../utils/amounts.js";
import { resolveSolanaAdapterPayload } from "./nonEvmPayloads.js";
import { simulateSolanaAdapter, submitSolanaAdapter } from "./solanaAdapterSubmitter.js";
import { solanaLamportsFeeLine, sumFeeLinesUsd } from "../fees/transactionFeeUtils.js";

const require = createRequire(import.meta.url);
let KaminoSdk: any = null;
let createV2Rpc: ((url: string) => any) | null = null;
try {
  KaminoSdk = require("@kamino-finance/klend-sdk");
  // Load web3.js v2 Rpc helpers from the klend-sdk's own dependency chain,
  // since @kamino-finance/klend-sdk@v8 uses @solana/rpc v2 internally.
  const sdkPath = require.resolve("@kamino-finance/klend-sdk");
  const sdkDir = path.dirname(sdkPath);
  const klendRequire = createRequire(path.join(sdkDir, "index.js"));
  const { createDefaultRpcTransport, createSolanaRpcFromTransport } = klendRequire("@solana/rpc");
  createV2Rpc = (url: string) => {
    const transport = createDefaultRpcTransport({ url });
    return createSolanaRpcFromTransport(transport);
  };
} catch (e) {
  console.warn("Could not load @kamino-finance/klend-sdk via CJS require:", e);
}
const NO_MARKET_SENTINEL = "<kamino-lending-market>";

export type KaminoAction =
  | "DepositReserveLiquidity"
  | "WithdrawReserveLiquidity"
  | "BorrowObligationLiquidity"
  | "RepayObligationLiquidity"
  | "RefreshReserve"
  | "RefreshObligation";

export interface KaminoAdapterAction {
  intentId?: string;
  action?: KaminoAction;
  amount?: string;
  amountRaw?: string;
  executionAmount?: string;
  market?: string;
  asset?: string;
  reserve?: string;
  obligation?: string;
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

/**
 * Builds a vetted Kamino Lend instruction for the Solana adapter program.
 *
 * The backend/agent resolves the exact Kamino reserve, obligation, lending market,
 * and token vault accounts with the Kamino SDK (@kamino-finance/klend-sdk). The
 * on-chain adapter enforces the Kamino Lend program id and an allowlisted Anchor
 * discriminator before forwarding the CPI, then records a per-intent receipt PDA.
 */
export class KaminoLendService {
  async buildAndMaybeSubmit(action: KaminoAdapterAction): Promise<Record<string, unknown>> {
    const protocol = findProtocol("SOL_KAMINO_LEND");
    const adapterProgramId = env.solanaKaminoAdapterProgramId || protocol.adapterProgramId;
    let selectedAction = normalizeKaminoAction(action.action);
    const market = action.market || env.kaminoMainMarket || NO_MARKET_SENTINEL;
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

    if ((!resolvedCpiDataBase64 || !resolvedRemainingAccounts?.length) && market !== NO_MARKET_SENTINEL && action.asset) {
      try {
        const chain = findChainByKey("SOLANA_DEVNET");
        const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
        const marketPubkey = new PublicKey(market);
        if (KaminoSdk && createV2Rpc) {
          // Create a web3.js v2 Rpc from the klend-sdk's own dependency chain
          // (klend-sdk v8 uses @solana/rpc v2 internally, not web3.js v1 Connection)
          const rpc = createV2Rpc(rpcUrl);
          // Pass marketAddress as string (v2 Address type) and skip reserve loading
          // to avoid oracle resolution failures on devnet (missing Pyth accounts).
          const marketObj = await KaminoSdk.KaminoMarket.load(rpc, marketPubkey.toBase58(), 400, protocol.programId, false);
          
          if (marketObj) {
            const amount = action.amountRaw ?? action.executionAmount ?? action.amount ?? "0";
            const mint = action.asset;
            // Use a dummy signer for the instruction builder; adapter will overwrite the signer.
            const dummySigner = "11111111111111111111111111111111";
            const obligation = new KaminoSdk.VanillaObligation(new KaminoSdk.PROGRAM_ID(protocol.programId));
            
            let kaminoAction;
            if (selectedAction === "DepositReserveLiquidity") {
              kaminoAction = await KaminoSdk.KaminoAction.buildDepositReserveLiquidityTxns(marketObj, amount, mint, dummySigner, obligation);
            } else if (selectedAction === "WithdrawReserveLiquidity") {
              kaminoAction = await KaminoSdk.KaminoAction.buildWithdrawReserveLiquidityTxns(marketObj, amount, mint, dummySigner, obligation);
            } else if (selectedAction === "BorrowObligationLiquidity") {
              kaminoAction = await KaminoSdk.KaminoAction.buildBorrowTxns(marketObj, amount, mint, dummySigner, obligation);
            } else if (selectedAction === "RepayObligationLiquidity") {
              kaminoAction = await KaminoSdk.KaminoAction.buildRepayTxns(marketObj, amount, mint, dummySigner, obligation);
            }

            if (kaminoAction) {
              const ix = kaminoAction.lendingIxs[0] || kaminoAction.setupIxs[0];
              if (ix) {
                resolvedCpiDataBase64 = Buffer.from(ix.data).toString("base64");
                resolvedRemainingAccounts = ix.keys.map((k: any) => ({
                  // v2 keys carry pubkey as string (Address type)
                  pubkey: typeof k.pubkey === "string" ? k.pubkey : k.pubkey.toBase58?.(),
                  isWritable: k.isWritable,
                  isSigner: k.isSigner
                }));
              }
            }
          }
        } else if (selectedAction === "RefreshReserve") {
          resolvedCpiDataBase64 = buildRefreshReserveCpi();
          resolvedRemainingAccounts = buildRefreshReserveAccounts(reservePk(market, action.reserve));
        } else {
          throw new Error("Kamino SDK unavailable; cannot build a real lending action payload.");
        }
      } catch (err) {
        console.error("Kamino SDK builder failed:", err);
        if (selectedAction === "RefreshReserve") {
          resolvedCpiDataBase64 = buildRefreshReserveCpi();
          resolvedRemainingAccounts = buildRefreshReserveAccounts(reservePk(market, action.reserve));
        } else {
          throw err;
        }
      }
    }

    const isConfigured = Boolean(adapterProgramId && resolvedCpiDataBase64 && resolvedRemainingAccounts?.length);
    const adapterInvocation = {
      programId: adapterProgramId,
      instruction: "execute",
      accounts: [
        { name: "config", pdaSeeds: ["kamino-config"] },
        { name: "receipt", pdaSeeds: ["kamino-receipt", action.intentId ?? "<intent-id-bytes32>"] },
        { name: "authority", signer: true, writable: true },
        { name: "kaminoProgram", pubkey: protocol.programId },
        { name: "systemProgram", pubkey: "11111111111111111111111111111111" },
        { name: "remainingAccounts", source: "Kamino klend SDK reserve/obligation resolver", value: resolvedRemainingAccounts ?? [] }
      ],
      args: {
        intentId: action.intentId ?? "<intent-id-bytes32>",
        action: selectedAction,
        amount: action.amountRaw ?? action.executionAmount ?? action.amount ?? "0",
        reserve: action.reserve ?? "<reserve-pubkey>",
        obligation: action.obligation ?? "<obligation-pubkey>",
        cpiDataBase64: resolvedCpiDataBase64 ?? "<serialized Kamino Anchor instruction data>",
        memo: action.memo ?? "Chrysalis V2 Kamino Lend intent"
      }
    };

    if (action.simulateOnly && isConfigured) {
      const result = await simulateSolanaAdapter({
        protocol: "kamino",
        adapterProgramId,
        protocolProgramId: protocol.programId,
        intentId: action.intentId ?? "simulation",
        actionIndex: KAMINO_ACTION_INDEX[selectedAction],
        amount: rawAmount(action.amountRaw ?? action.executionAmount ?? action.amount, 6),
        cpiDataBase64: resolvedCpiDataBase64!,
        remainingAccounts: resolvedRemainingAccounts!,
        memo: action.memo ?? "Chrysalis V2 Kamino Lend intent",
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
        lendingMarket: market,
        simulation: result,
        adapterInvocation
      };
    }

    if (!env.agentDryRun && isConfigured) {
      try {
        const result = await submitSolanaAdapter({
          protocol: "kamino",
          adapterProgramId,
          protocolProgramId: protocol.programId,
          intentId: action.intentId ?? "",
          actionIndex: KAMINO_ACTION_INDEX[selectedAction],
          amount: rawAmount(action.amountRaw ?? action.executionAmount ?? action.amount, 6),
          cpiDataBase64: resolvedCpiDataBase64!,
          remainingAccounts: resolvedRemainingAccounts!,
          memo: action.memo ?? "Chrysalis V2 Kamino Lend intent",
          computeUnitLimit: numberFromAction(action.computeUnitLimit),
          computeUnitPriceMicroLamports: numberFromAction(action.computeUnitPriceMicroLamports)
        });
        const feeLines = result.feeLamports && result.signature
          ? [await solanaLamportsFeeLine({
              label: "Kamino Solana execution",
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
          lendingMarket: market,
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
          lendingMarket: market,
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
      lendingMarket: market,
      adapterInvocation,
      safetyChecks: [
        "adapter validates the configured Kamino Lend program id",
        "adapter validates the allowed Kamino Anchor discriminator for the selected action",
        "adapter records an on-chain receipt PDA after a successful CPI"
      ],
      note: isConfigured
        ? `Kamino adapter payload built. Action: ${selectedAction}. ${env.agentDryRun ? "AGENT_DRY_RUN enabled — transaction not submitted." : "Transaction submitted to devnet."}`
        : "Kamino live execution is not configured. Resolve the lending market, reserve, obligation, collateral/liquidity vaults, oracle accounts, cpiDataBase64, and remaining accounts with the Kamino klend SDK before submitting."
    };
  }
}

const KAMINO_ACTION_INDEX: Record<KaminoAction, number> = {
  DepositReserveLiquidity: 0,
  WithdrawReserveLiquidity: 1,
  BorrowObligationLiquidity: 2,
  RepayObligationLiquidity: 3,
  RefreshReserve: 4,
  RefreshObligation: 5
};

// Devnet USDC reserve in the Main market ARVAgHAZiNGCbZ8Cb4BitwZoNQ8eBWsk7ZeinPgmNjgi.
// This is the only Kamino reserve on devnet and has no oracle configured,
// so only RefreshReserve (no oracle dependency) works for on-chain testing.
const DEVNET_USDC_RESERVE = "AQXRKeouEsG9FDTUSjhvzFCRjTuzLPV9Li7XU42DKpXJ";

function reservePk(market: string, explicitReserve?: string): string {
  return explicitReserve ?? DEVNET_USDC_RESERVE;
}

function buildRefreshReserveCpi(): string {
  return createHash("sha256").update("global:refresh_reserve").digest().subarray(0, 8).toString("base64");
}

function buildRefreshReserveAccounts(reserve: string): Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }> {
  return [
    { pubkey: reserve, isWritable: true, isSigner: false },
    { pubkey: "ARVAgHAZiNGCbZ8Cb4BitwZoNQ8eBWsk7ZeinPgmNjgi", isWritable: false, isSigner: false }
  ];
}

function normalizeKaminoAction(action: unknown): KaminoAction {
  if (
    action === "WithdrawReserveLiquidity" ||
    action === "BorrowObligationLiquidity" ||
    action === "RepayObligationLiquidity" ||
    action === "RefreshReserve" ||
    action === "RefreshObligation"
  ) return action;
  return "DepositReserveLiquidity";
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
