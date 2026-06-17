import type { TransactionReceipt } from "viem";
import type { Connection } from "@solana/web3.js";
import { findChainByKey } from "../../config/index.js";
import type { FeeLineItem } from "../../types.js";
import { formatUnitsDecimal } from "../../utils/amounts.js";
import { liveQuoteService } from "./liveQuoteService.js";
import { toNumber, usd } from "./math.js";

function nativeSymbol(chainKey: string): string {
  const chain = findChainByKey(chainKey);
  return String(chain.nativeCurrency?.symbol ?? (chain.vm === "svm" ? "SOL" : chain.vm === "soroban" ? "XLM" : "ETH"));
}

function nativeDecimals(chainKey: string): number {
  const chain = findChainByKey(chainKey);
  return Number(chain.nativeCurrency?.decimals ?? 18);
}

async function nativeUsdPrice(symbol: string): Promise<number> {
  const upper = symbol.toUpperCase();
  if (upper === "USDC" || upper === "EURC" || upper === "USD") return 1;
  const prices = await liveQuoteService.getTokenPrices();
  if (upper === "SOL") return prices.solana;
  if (upper === "XLM") return prices.stellar;
  return prices.ethereum;
}

function nativeAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 0.000001) return value.toExponential(2);
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

export async function evmTransactionFeeLine(input: {
  chainKey: string;
  label: string;
  txHash?: string;
  chargedBy?: FeeLineItem["chargedBy"];
  payer?: FeeLineItem["payer"];
  receipt: Pick<TransactionReceipt, "gasUsed" | "effectiveGasPrice">;
}): Promise<FeeLineItem | undefined> {
  const gasUsed = input.receipt.gasUsed;
  const gasPrice = input.receipt.effectiveGasPrice;
  if (gasUsed === undefined || gasPrice === undefined) return undefined;

  const symbol = nativeSymbol(input.chainKey);
  const rawFee = gasUsed * gasPrice;
  const amount = toNumber(formatUnitsDecimal(rawFee, nativeDecimals(input.chainKey)), 0);
  const amountUsd = amount * await nativeUsdPrice(symbol);
  return {
    key: `actual_${input.chainKey.toLowerCase()}_${input.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    label: input.label,
    chargedBy: input.chargedBy ?? "destination_chain",
    payer: input.payer ?? "user",
    amount: nativeAmount(amount),
    currency: symbol,
    amountUsd: usd(amountUsd),
    isEstimate: false,
    notes: input.txHash ? [`Actual fee from transaction ${input.txHash}.`] : ["Actual fee from confirmed transaction receipt."]
  };
}

export async function solanaLamportsFeeLine(input: {
  label: string;
  feeLamports: bigint | number | string;
  txHash?: string;
  chargedBy?: FeeLineItem["chargedBy"];
  payer?: FeeLineItem["payer"];
}): Promise<FeeLineItem> {
  const lamports = BigInt(input.feeLamports);
  const amount = Number(lamports) / 1e9;
  const amountUsd = amount * await nativeUsdPrice("SOL");
  return {
    key: `actual_solana_${input.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    label: input.label,
    chargedBy: input.chargedBy ?? "destination_chain",
    payer: input.payer ?? "user",
    amount: nativeAmount(amount),
    currency: "SOL",
    amountUsd: usd(amountUsd),
    isEstimate: false,
    notes: input.txHash ? [`Actual fee from transaction ${input.txHash}.`] : ["Actual fee from confirmed Solana transaction."]
  };
}

export async function solanaTransactionFeeLine(input: {
  connection: Connection;
  label: string;
  txHash: string;
  chargedBy?: FeeLineItem["chargedBy"];
  payer?: FeeLineItem["payer"];
}): Promise<FeeLineItem | undefined> {
  const tx = await input.connection.getTransaction(input.txHash, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0
  });
  if (tx?.meta?.fee === undefined || tx.meta.fee === null) return undefined;
  return solanaLamportsFeeLine({
    label: input.label,
    feeLamports: tx.meta.fee,
    txHash: input.txHash,
    chargedBy: input.chargedBy,
    payer: input.payer
  });
}

export async function stellarStroopsFeeLine(input: {
  label: string;
  feeStroops: bigint | number | string;
  txHash?: string;
  chargedBy?: FeeLineItem["chargedBy"];
  payer?: FeeLineItem["payer"];
}): Promise<FeeLineItem> {
  const stroops = BigInt(input.feeStroops);
  const amount = Number(stroops) / 1e7;
  const amountUsd = amount * await nativeUsdPrice("XLM");
  return {
    key: `actual_stellar_${input.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    label: input.label,
    chargedBy: input.chargedBy ?? "destination_chain",
    payer: input.payer ?? "user",
    amount: nativeAmount(amount),
    currency: "XLM",
    amountUsd: usd(amountUsd),
    isEstimate: false,
    notes: input.txHash ? [`Actual fee from transaction ${input.txHash}.`] : ["Actual fee from confirmed Stellar transaction."]
  };
}

export function sumFeeLinesUsd(lines: FeeLineItem[]): string {
  return usd(lines.reduce((sum, line) => sum + toNumber(line.amountUsd, 0), 0));
}
