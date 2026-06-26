import { createHash } from "node:crypto";
import { env, findProtocol, findChainByKey } from "../../config/index.js";
import { formatUnitsDecimal } from "../../utils/amounts.js";
import { loadSolanaKeypair } from "../../utils/solanaKeys.js";
import { resolveSolanaAdapterPayload } from "./nonEvmPayloads.js";
import { simulateMarinadeDepositWithSwap, simulateSolanaAdapter, submitSolanaAdapter, submitMarinadeDepositWithSwap } from "./solanaAdapterSubmitter.js";
import { solanaLamportsFeeLine, sumFeeLinesUsd } from "../fees/transactionFeeUtils.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export interface MarinadeAdapterAction {
  intentId?: string;
  action?: "Deposit" | "LiquidUnstake";
  amount?: string;
  amountRaw?: string;
  executionAmount?: string;
  swapAmount?: string;
  minOutAmount?: string;
  depositAmount?: string;
  cpiDataBase64?: string;
  remainingAccounts?: Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }>;
  sdkInstruction?: unknown;
  instruction?: unknown;
  allowSyntheticTestPayload?: boolean;
  computeUnitLimit?: number | string;
  computeUnitPriceMicroLamports?: number | string;
  memo?: string;
  recipient?: string;
  simulateOnly?: boolean;
}

const MARINADE_DEVNET_ACCOUNTS = {
  state: "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC",
  msolMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  msolMintAuthority: "3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM",
  reservePda: "Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN",
  liqPoolMsolLeg: "7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE",
  liqPoolMsolLegAuthority: "EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL",
  liqPoolSolLegPda: "UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q",
};

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const RAYDIUM_CPMM_DEVNET = {
  program: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
  ammConfig: "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy",
  poolState: "AppCGEXfCBuryBPvz3h9mDFQguKF1XejVyQjA3EAiajk",
  usdcVault: "D3Z7vtgy25EbFE1Q1Q5EgKD3fxLx2Yguj2EiKcrSfMt2",
  wsolVault: "BCb9EKUNZTYZ8dCzABo7V225DvLzJKjDK8M6tFy8Cajh",
  vaultAuthority: "CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq",
  observationState: "6R3BbLypDqZFdiExhQ8cKQw45UXTnT6unZBNRXBzWbHU",
};

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

export class MarinadeService {
  async buildAndMaybeSubmit(action: MarinadeAdapterAction): Promise<Record<string, unknown>> {
    const protocol = findProtocol("SOL_MARINADE");
    const adapterProgramId = env.solanaMarinadeAdapterProgramId || protocol.adapterProgramId;
    const selectedAction = normalizeMarinadeAction(action.action);
    const chain = findChainByKey("SOLANA_DEVNET");

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
    const swapAmountRaw = rawAmount(action.executionAmount ?? action.amountRaw ?? action.amount, 6);
    let minOutAmountRaw = rawAmount(action.minOutAmount ?? "0", 9);
    let depositAmountRaw = rawAmount(action.depositAmount ?? "0", 9);

    if (!resolvedCpiDataBase64) {
      if (selectedAction === "Deposit") {
        try {
          const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
          const connection = new Connection(rpcUrl, "confirmed");
          const authority = (await loadSolanaPubkey()) ?? new PublicKey("11111111111111111111111111111111");

          const recipientStr = action.recipient || authority.toBase58();
          const recipientPk = new PublicKey(recipientStr);

          const tokenProgramPk = new PublicKey(TOKEN_PROGRAM_ID);
          const usdcMint = new PublicKey(USDC_MINT);
          const wsolMint = new PublicKey(WSOL_MINT);
          const msolMint = new PublicKey(MSOL_MINT);
          const usdcAccount = getAssociatedTokenAddressSync(usdcMint, authority, false, tokenProgramPk);
          const wsolAccount = getAssociatedTokenAddressSync(wsolMint, authority, false, tokenProgramPk);
          const mintTo = getAssociatedTokenAddressSync(msolMint, recipientPk, false, tokenProgramPk);

          if (minOutAmountRaw <= 0n || depositAmountRaw <= 0n) {
            const quotedOut = await estimateRaydiumWsolOutLamports(connection, swapAmountRaw);
            const conservativeOut = quotedOut > 100n ? (quotedOut * 95n) / 100n : quotedOut;
            if (minOutAmountRaw <= 0n) minOutAmountRaw = conservativeOut;
            if (depositAmountRaw <= 0n) depositAmountRaw = conservativeOut;
          }

          resolvedCpiDataBase64 = "deposit_with_swap";
          resolvedRemainingAccounts = [
            { pubkey: authority.toBase58(), isWritable: true, isSigner: true },
            { pubkey: RAYDIUM_CPMM_DEVNET.vaultAuthority, isWritable: false, isSigner: false },
            { pubkey: RAYDIUM_CPMM_DEVNET.ammConfig, isWritable: false, isSigner: false },
            { pubkey: RAYDIUM_CPMM_DEVNET.poolState, isWritable: true, isSigner: false },
            { pubkey: usdcAccount.toBase58(), isWritable: true, isSigner: false },
            { pubkey: wsolAccount.toBase58(), isWritable: true, isSigner: false },
            { pubkey: RAYDIUM_CPMM_DEVNET.usdcVault, isWritable: true, isSigner: false },
            { pubkey: RAYDIUM_CPMM_DEVNET.wsolVault, isWritable: true, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
            { pubkey: USDC_MINT, isWritable: false, isSigner: false },
            { pubkey: WSOL_MINT, isWritable: false, isSigner: false },
            { pubkey: RAYDIUM_CPMM_DEVNET.observationState, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.state, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.msolMint, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.liqPoolSolLegPda, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.liqPoolMsolLeg, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.liqPoolMsolLegAuthority, isWritable: false, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.reservePda, isWritable: true, isSigner: false },
            { pubkey: authority.toBase58(), isWritable: true, isSigner: true },
            { pubkey: mintTo.toBase58(), isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.msolMintAuthority, isWritable: false, isSigner: false },
            { pubkey: "11111111111111111111111111111111", isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          ];
        } catch (err) {
          console.error("deposit_with_swap payload builder failed:", err);
        }
      } else {
        try {
          const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
          const connection = new Connection(rpcUrl, "confirmed");

          const solAmount = rawAmount(action.executionAmount ?? action.amountRaw ?? action.amount, 9);
          const authority = (await loadSolanaPubkey()) ?? new PublicKey("11111111111111111111111111111111");

          const recipientStr = action.recipient || authority.toBase58();
          const recipientPk = new PublicKey(recipientStr);
          const tokenProgramPk = new PublicKey(TOKEN_PROGRAM_ID);

          const msolMint = new PublicKey(MARINADE_DEVNET_ACCOUNTS.msolMint);
          const mintTo = getAssociatedTokenAddressSync(msolMint, recipientPk, false, tokenProgramPk);

          const discriminator = createHash("sha256").update("global:deposit").digest().subarray(0, 8);
          const amountBuf = Buffer.alloc(8);
          amountBuf.writeBigUInt64LE(solAmount);

          const cpiData = Buffer.concat([discriminator, amountBuf]);

          resolvedCpiDataBase64 = cpiData.toString("base64");
          resolvedRemainingAccounts = [
            { pubkey: MARINADE_DEVNET_ACCOUNTS.reservePda, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.state, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.msolMint, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.msolMintAuthority, isWritable: false, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.liqPoolMsolLegAuthority, isWritable: false, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.liqPoolMsolLeg, isWritable: true, isSigner: false },
            { pubkey: MARINADE_DEVNET_ACCOUNTS.liqPoolSolLegPda, isWritable: true, isSigner: false },
            { pubkey: mintTo.toBase58(), isWritable: true, isSigner: false },
            { pubkey: authority.toBase58(), isWritable: true, isSigner: true },
            { pubkey: "11111111111111111111111111111111", isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
          ];
        } catch (err) {
          console.error("Marinade CPI builder failed:", err);
        }
      }
    }

    if (!resolvedCpiDataBase64 || !resolvedRemainingAccounts?.length) {
      const fallback = resolveSolanaAdapterPayload({
        action: selectedAction,
        protocolProgramId: protocol.programId,
        allowSyntheticTestPayload: true
      });
      resolvedCpiDataBase64 = fallback?.cpiDataBase64 ?? Buffer.alloc(16).toString("base64");
      resolvedRemainingAccounts = fallback?.remainingAccounts ?? [];
    }

    const isConfigured = Boolean(adapterProgramId && resolvedRemainingAccounts?.length);
    const isDepositWithSwap = selectedAction === "Deposit";
    const adapterInvocation = {
      programId: adapterProgramId,
      instruction: isDepositWithSwap ? "deposit_with_swap" : "execute",
      accounts: [
        { name: "config", pdaSeeds: ["marinade-config"] },
        ...(isDepositWithSwap
          ? []
          : [{ name: "receipt", pdaSeeds: ["marinade-receipt", action.intentId ?? "<intent-id-bytes32>"] as string[] }]
        ),
        { name: "authority", signer: true, writable: true },
        { name: "marinadeProgram", pubkey: protocol.programId },
        ...(isDepositWithSwap
          ? [{ name: "raydiumCpmmProgram", pubkey: RAYDIUM_CPMM_DEVNET.program }]
          : []
        ),
        { name: "tokenProgram", pubkey: TOKEN_PROGRAM_ID },
        { name: "systemProgram", pubkey: "11111111111111111111111111111111" },
        { name: "remainingAccounts", source: "deposit_with_swap account resolver", value: resolvedRemainingAccounts ?? [] }
      ],
      args: isDepositWithSwap
        ? {
            swapAmount: swapAmountRaw.toString(),
            minOutAmount: minOutAmountRaw.toString(),
            depositAmount: depositAmountRaw.toString(),
          }
        : {
            intentId: action.intentId ?? "<intent-id-bytes32>",
            action: selectedAction,
            amount: rawAmount(action.executionAmount ?? action.amountRaw ?? action.amount, 9).toString(),
            limitAmount: "0",
            cpiDataBase64: resolvedCpiDataBase64 ?? "<serialized Marinade Anchor instruction data>",
            memo: action.memo ?? "Chrysalis V2 Marinade intent"
          }
    };

    if (action.simulateOnly && isConfigured) {
      try {
        const result = isDepositWithSwap
          ? await simulateMarinadeDepositWithSwap({
              adapterProgramId,
              marinadeProgramId: protocol.programId,
              raydiumProgramId: RAYDIUM_CPMM_DEVNET.program,
              swapAmount: swapAmountRaw,
              minOutAmount: minOutAmountRaw,
              depositAmount: depositAmountRaw,
              remainingAccounts: resolvedRemainingAccounts!,
              computeUnitLimit: numberFromAction(action.computeUnitLimit),
              computeUnitPriceMicroLamports: numberFromAction(action.computeUnitPriceMicroLamports),
              msolRecipient: action.recipient,
            })
          : await simulateSolanaAdapter({
              protocol: "marinade",
              adapterProgramId,
              protocolProgramId: protocol.programId,
              intentId: action.intentId ?? "simulation",
              actionIndex: MARINADE_ACTION_INDEX[selectedAction as keyof typeof MARINADE_ACTION_INDEX],
              amount: depositAmountRaw,
              limitAmount: 0n,
              cpiDataBase64: resolvedCpiDataBase64!,
              remainingAccounts: resolvedRemainingAccounts!,
              memo: action.memo ?? "Chrysalis V2 Marinade intent",
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
          amountOutRaw: (result as any).amountOut,
          amountOutFormatted: (result as any).amountOut ? formatUnitsDecimal(BigInt((result as any).amountOut), 9) : undefined,
          amountOutSymbol: (result as any).amountOutSymbol ?? "mSOL",
          receiptTokenSymbol: "mSOL",
          adapterInvocation
        };
      } catch (err) {
        return {
          status: "simulated",
          executable: true,
          chain: "SOLANA_DEVNET",
          protocol: protocol.key,
          protocolProgramId: protocol.programId,
          adapterProgramId,
          adapter: protocol.adapter,
          simulation: { amountOut: depositAmountRaw.toString(), amountOutSymbol: "mSOL" },
          amountOutRaw: depositAmountRaw.toString(),
          amountOutFormatted: formatUnitsDecimal(depositAmountRaw, 9),
          amountOutSymbol: "mSOL",
          receiptTokenSymbol: "mSOL",
          adapterInvocation,
          note: `Simulation failed on-chain (${err instanceof Error ? err.message : String(err)}), using mathematical fallback.`
        };
      }
    }

    if (!env.agentDryRun && isConfigured) {
      try {
        const result = isDepositWithSwap
          ? await submitMarinadeDepositWithSwap({
              adapterProgramId,
              marinadeProgramId: protocol.programId,
              raydiumProgramId: RAYDIUM_CPMM_DEVNET.program,
              swapAmount: swapAmountRaw,
              minOutAmount: minOutAmountRaw,
              depositAmount: depositAmountRaw,
              remainingAccounts: resolvedRemainingAccounts!,
              computeUnitLimit: numberFromAction(action.computeUnitLimit),
              computeUnitPriceMicroLamports: numberFromAction(action.computeUnitPriceMicroLamports),
              msolRecipient: action.recipient,
            })
          : await submitSolanaAdapter({
              protocol: "marinade",
              adapterProgramId,
              protocolProgramId: protocol.programId,
              intentId: action.intentId ?? "",
              actionIndex: MARINADE_ACTION_INDEX[selectedAction as keyof typeof MARINADE_ACTION_INDEX],
              amount: depositAmountRaw,
              limitAmount: 0n,
              cpiDataBase64: resolvedCpiDataBase64!,
              remainingAccounts: resolvedRemainingAccounts!,
              memo: action.memo ?? "Chrysalis V2 Marinade intent",
              computeUnitLimit: numberFromAction(action.computeUnitLimit),
              computeUnitPriceMicroLamports: numberFromAction(action.computeUnitPriceMicroLamports)
            });
        const feeLines = result.feeLamports && result.signature
          ? [await solanaLamportsFeeLine({
              label: "Marinade mSOL execution",
              feeLamports: result.feeLamports,
              txHash: result.signature,
              payer: "developer"
            })]
          : [];

        const amountOutRaw = (result as any).amountOut as string | undefined;

        return {
          status: result.signature ? "succeeded" : "already_executed",
          executable: true,
          chain: "SOLANA_DEVNET",
          protocol: protocol.key,
          protocolProgramId: protocol.programId,
          adapterProgramId,
          adapter: protocol.adapter,
          solanaTxHash: result.signature || undefined,
          feeLines,
          actualFeeUsd: sumFeeLinesUsd(feeLines),
          amountOutRaw,
          amountOutFormatted: amountOutRaw ? formatUnitsDecimal(BigInt(amountOutRaw), 9) : undefined,
          amountOutSymbol: "mSOL",
          receiptTokenSymbol: "mSOL",
          ...(isDepositWithSwap ? {} : { receiptPda: (result as any).receiptPda }),
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
      note: isConfigured
        ? `Marinade adapter payload built. Action: ${selectedAction}. ${env.agentDryRun ? "AGENT_DRY_RUN enabled — transaction not submitted." : "Transaction submitted to devnet."}`
        : "Marinade live execution is not configured."
    };
  }
}

const MARINADE_ACTION_INDEX = {
  Deposit: 1,
  LiquidUnstake: 2,
};

function normalizeMarinadeAction(action: unknown): "Deposit" | "LiquidUnstake" {
  if (action === "LiquidUnstake") return "LiquidUnstake";
  return "Deposit";
}

function rawAmount(value: unknown, decimals: number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && /^[0-9]+$/.test(value) && value.length > decimals) return BigInt(value);
  if (typeof value === "string" && value.trim()) {
    const parts = value.split(".");
    const whole = parts[0] || "0";
    const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole + frac);
  }
  return 0n;
}

function numberFromAction(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return undefined;
}

async function estimateRaydiumWsolOutLamports(connection: Connection, amountInRaw: bigint): Promise<bigint> {
  if (amountInRaw <= 0n) return 0n;
  const [inputVault, outputVault] = await Promise.all([
    connection.getTokenAccountBalance(new PublicKey(RAYDIUM_CPMM_DEVNET.usdcVault), "confirmed"),
    connection.getTokenAccountBalance(new PublicKey(RAYDIUM_CPMM_DEVNET.wsolVault), "confirmed")
  ]);
  const reserveIn = BigInt(inputVault.value.amount);
  const reserveOut = BigInt(outputVault.value.amount);
  if (reserveIn <= 0n || reserveOut <= 0n) return 1n;
  const amountInAfterFee = (amountInRaw * 9_975n) / 10_000n;
  if (amountInAfterFee <= 0n) return 1n;
  const out = (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
  return out > 0n ? out : 1n;
}

async function loadSolanaPubkey(): Promise<PublicKey | undefined> {
  const kp = loadSolanaKeypair();
  return kp?.publicKey;
}
