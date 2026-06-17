import { feeModel, findChainByKey, env } from "../../config/index.js";
import { CreateIntentInput, FeeLineItem, RouteKind } from "../../types.js";
import { toNumber, usd } from "./math.js";
import { liveQuoteService } from "./liveQuoteService.js";

export interface GasEstimate {
  sourceGasUsd: number;
  destinationGasUsd: number;
  arcGasUsd: number;
  sourceGas: NativeGasEstimate;
  destinationGas: NativeGasEstimate;
  lines: FeeLineItem[];
  warnings: string[];
  assumptions: string[];
}

export interface NativeGasEstimate {
  amount: number;
  token: string;
  amountUsd: number;
  live: boolean;
}

function chainGas(chain: string): any {
  return feeModel.chainGasUsd?.[chain] ?? { bridgeGasUsd: 0.01, executionGasUsd: 0.02, currency: "native", paymasterEligible: false };
}

function getFallbackGasUsd(chain: string): number {
  if (chain === "ARC") return env.gasUsdArc;
  if (chain === "BASE_SEPOLIA") return env.gasUsdBaseSepolia;
  if (chain === "ETHEREUM_SEPOLIA") return env.gasUsdEthereumSepolia;
  if (chain === "SOLANA_DEVNET") return env.gasUsdSolanaDevnet;
  if (chain === "STELLAR_TESTNET") return env.gasUsdStellarTestnet;
  return toNumber(chainGas(chain).bridgeGasUsd, 0.01);
}

function gasTokenSymbol(chainConfig: any): string {
  const configured = String(chainConfig?.nativeCurrency?.symbol ?? "").toUpperCase();
  if (configured) return configured;
  if (chainConfig?.vm === "svm") return "SOL";
  if (chainConfig?.vm === "soroban") return "XLM";
  return "ETH";
}

function nativeUsdPrice(symbol: string, tokenPrices: { ethereum: number; solana: number; stellar: number }): number {
  const upper = symbol.toUpperCase();
  if (upper === "USDC" || upper === "EURC" || upper === "USD") return 1;
  if (upper === "SOL") return tokenPrices.solana;
  if (upper === "XLM") return tokenPrices.stellar;
  return tokenPrices.ethereum;
}

export function gasAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 0.000001) return value.toExponential(2);
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function fallbackNativeGas(
  chainConfig: any,
  fallbackUsd: number,
  tokenPrices: { ethereum: number; solana: number; stellar: number }
): NativeGasEstimate {
  const token = gasTokenSymbol(chainConfig);
  const price = nativeUsdPrice(token, tokenPrices);
  return {
    amount: price > 0 ? fallbackUsd / price : fallbackUsd,
    token,
    amountUsd: fallbackUsd,
    live: false
  };
}

export class GasEstimator {
  /** Resolves a single chain's gas cost in native token units from live RPC data, with static fallback. */
  private async liveChainGas(
    chainConfig: any,
    gasLimit: number,
    tokenPrices: { ethereum: number; solana: number; stellar: number },
    fallbackUsd: number,
    side: "Source" | "Destination",
    assumptions: string[]
  ): Promise<NativeGasEstimate> {
    const rpcUrl = process.env[chainConfig.rpcEnv] ?? chainConfig.rpcUrl;
    const token = gasTokenSymbol(chainConfig);
    const nativeUsd = nativeUsdPrice(token, tokenPrices);
    if (chainConfig.vm === "evm") {
      const gasPriceWei = await liveQuoteService.getLiveGasPriceWei(rpcUrl);
      if (gasPriceWei > 0n) {
        const decimals = Number(chainConfig.nativeCurrency?.decimals ?? 18);
        const gasCostNative = Number(gasPriceWei * BigInt(gasLimit)) / 10 ** decimals;
        assumptions.push(`${side} gas estimated live (gasPrice ${gasPriceWei.toString()} wei, ${gasAmount(gasCostNative)} ${token}).`);
        return { amount: gasCostNative, token, amountUsd: gasCostNative * nativeUsd, live: true };
      }
      assumptions.push(`${side} gas fell back to static model due to zero RPC gasPrice.`);
      return fallbackNativeGas(chainConfig, fallbackUsd, tokenPrices);
    }
    if (chainConfig.vm === "svm") {
      const solUsd = await liveQuoteService.getSolanaGasUsd(rpcUrl, tokenPrices.solana, gasLimit);
      if (solUsd !== null) {
        const solAmount = solUsd / tokenPrices.solana;
        assumptions.push(`${side} gas estimated live from Solana priority fees (${gasAmount(solAmount)} SOL).`);
        return { amount: solAmount, token: "SOL", amountUsd: solUsd, live: true };
      }
      assumptions.push(`${side} gas fell back to static Solana estimation.`);
      return fallbackNativeGas(chainConfig, fallbackUsd, tokenPrices);
    }
    if (chainConfig.vm === "soroban") {
      const xlmUsd = await liveQuoteService.getStellarGasUsd(rpcUrl, tokenPrices.stellar);
      if (xlmUsd !== null) {
        const xlmAmount = xlmUsd / tokenPrices.stellar;
        assumptions.push(`${side} gas estimated live from Stellar fee stats (${gasAmount(xlmAmount)} XLM).`);
        return { amount: xlmAmount, token: "XLM", amountUsd: xlmUsd, live: true };
      }
      assumptions.push(`${side} gas fell back to static Stellar estimation.`);
      return fallbackNativeGas(chainConfig, fallbackUsd, tokenPrices);
    }
    return fallbackNativeGas(chainConfig, fallbackUsd, tokenPrices);
  }

  async estimate(input: CreateIntentInput, routeKind: RouteKind): Promise<GasEstimate> {
    const source = chainGas(input.sourceChain);
    const destination = chainGas(input.destinationChain);
    const sourceChainConfig = findChainByKey(input.sourceChain);
    const destinationChainConfig = findChainByKey(input.destinationChain);
    const isLocal = routeKind === "LOCAL";

    const bridgeGasLimit = 150_000;
    const executionGasLimit = 250_000;

    let sourceGasUsd = isLocal ? 0 : getFallbackGasUsd(input.sourceChain);
    let destinationGasUsd = getFallbackGasUsd(input.destinationChain);
    const assumptions: string[] = [];
    let tokenPrices = { ethereum: 3500, solana: 150, stellar: 0.1 };
    let sourceGas = fallbackNativeGas(sourceChainConfig, sourceGasUsd, tokenPrices);
    let destinationGas = fallbackNativeGas(destinationChainConfig, destinationGasUsd, tokenPrices);

    if (env.liveFees) {
      try {
        tokenPrices = await liveQuoteService.getTokenPrices();
        sourceGas = fallbackNativeGas(sourceChainConfig, sourceGasUsd, tokenPrices);
        destinationGas = fallbackNativeGas(destinationChainConfig, destinationGasUsd, tokenPrices);

        // Live Source Gas Estimation
        if (!isLocal) {
          sourceGas = await this.liveChainGas(sourceChainConfig, bridgeGasLimit, tokenPrices, sourceGasUsd, "Source", assumptions);
          sourceGasUsd = sourceGas.amountUsd;
        }

        // Live Destination Gas Estimation
        destinationGas = await this.liveChainGas(destinationChainConfig, executionGasLimit, tokenPrices, destinationGasUsd, "Destination", assumptions);
        destinationGasUsd = destinationGas.amountUsd;
      } catch (err) {
        assumptions.push(`Live gas estimation failed; fell back to static defaults: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      assumptions.push("Gas estimates use static fee-model defaults because LIVE_FEES is disabled.");
    }

    const arcGasUsd = (input.sourceChain === "ARC" ? sourceGasUsd : 0) + (input.destinationChain === "ARC" ? destinationGasUsd : 0);
    const lines: FeeLineItem[] = [];

    if (sourceGasUsd > 0) {
      lines.push({
        key: "source_gas",
        label: `Source-chain transaction gas on ${input.sourceChain}`,
        chargedBy: "source_chain",
        payer: "user",
        amount: gasAmount(sourceGas.amount),
        currency: sourceGas.token,
        amountUsd: usd(sourceGasUsd),
        isEstimate: true,
        notes: ["Covers source bridge/deposit/burn transaction gas."]
      });
    }

    if (destinationGasUsd > 0) {
      lines.push({
        key: "destination_gas",
        label: `Destination protocol execution gas on ${input.destinationChain}`,
        chargedBy: "destination_chain",
        payer: "user",
        amount: gasAmount(destinationGas.amount),
        currency: destinationGas.token,
        amountUsd: usd(destinationGasUsd),
        isEstimate: true,
        notes: ["User pays destination execution gas directly."]
      });
    }

    return { sourceGasUsd, destinationGasUsd, arcGasUsd, sourceGas, destinationGas, lines, warnings: [], assumptions };
  }
}
