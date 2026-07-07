import { randomUUID } from "node:crypto";
import { agentPolicies, env, feeModel, findChainByKey, findProtocolWithChain, hasGatewayContracts } from "../config/index.js";
import { CircleFeeEstimator } from "../services/fees/circleFeeEstimator.js";
import { ProtocolFeeEstimator } from "../services/fees/protocolFeeEstimator.js";
import { SlippageEstimator } from "../services/fees/slippageEstimator.js";
import { liveQuoteService } from "../services/fees/liveQuoteService.js";
import { RouteSimulationService } from "../services/fees/routeSimulationService.js";
import { amount, clamp, toNumber, usd } from "../services/fees/math.js";
import {
  CreateIntentInput,
  FeeConfidence,
  FeeLineItem,
  FeeQuote,
  OptimizationGoal,
  RouteAlternative,
  RouteKind
} from "../types.js";

interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

function nativeAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 0.000001) return value.toExponential(2);
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeAddress(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function outputAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 0.000001) return value.toExponential(2);
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function friendlySimulationError(message: string): string {
  if (/429|rate.?limit|too many requests|request limit/i.test(message)) {
    return "RPC provider is rate limiting live simulation. Please retry in a few seconds or set a private RPC URL in .env.";
  }
  return message;
}

export class FeeQuoteAgent {
  private readonly circle = new CircleFeeEstimator();
  private readonly protocol = new ProtocolFeeEstimator();
  private readonly slippage = new SlippageEstimator();
  private readonly simulator = new RouteSimulationService();

  async quote(input: CreateIntentInput, routeKind: RouteKind): Promise<FeeQuote> {
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + (env.feeQuoteTtlSeconds || toNumber(feeModel.quoteTtlSeconds, 120)) * 1000);
    const circle = await this.circle.estimate(input, routeKind);
    const protocol = this.protocol.estimate(input);
    const bridgeFeeReducesProtocolAmount = routeKind !== "GATEWAY";
    const nonGasFeesUsd = (bridgeFeeReducesProtocolAmount ? circle.feeUsd : 0) + protocol.feeUsd;
    const slippage = this.slippage.estimate(input, nonGasFeesUsd);
    const simulation = await this.simulator.simulate(input, routeKind, {
      circleFeeUsd: circle.feeUsd,
      slippageBps: slippage.slippageBps
    });
    const output = await this.outputEstimate(input, simulation.outputAmount, simulation.minimumOutputAmount, simulation.outputTokenSymbol);
    const userGasUsd = simulation.sourceGas.amountUsd + simulation.destinationGas.amountUsd;
    const userPaysUsd = userGasUsd + circle.feeUsd + protocol.feeUsd + slippage.slippageUsd;
    const totalEstimatedCostUsd = simulation.sourceGas.amountUsd + simulation.destinationGas.amountUsd + circle.feeUsd + protocol.feeUsd + slippage.slippageUsd;
    const lines: FeeLineItem[] = [
      ...simulation.lines,
      ...circle.lines,
      ...protocol.lines,
      ...slippage.lines
    ];
    const warnings = [
      ...circle.warnings,
      ...protocol.warnings,
      ...slippage.warnings,
      ...this.userGuardWarnings(input, userPaysUsd, totalEstimatedCostUsd)
    ];
    const assumptions = [
      ...circle.assumptions,
      ...protocol.assumptions,
      ...simulation.assumptions,
      ...slippage.assumptions,
      "Gas and protocol output use full-flow simulation; quote is unavailable if simulation cannot be completed.",
      "All USD values are USDC-equivalent for route scoring only."
    ];

    return {
      quoteId: `quote_${randomUUID()}`,
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      quoteCurrency: "USDC",
      confidence: this.confidence(routeKind, warnings),
      routeKind,
      circleProduct: circle.circleProduct,
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain,
      protocol: input.protocol,
      action: input.action,
      amountIn: input.amount,
      asset: input.asset,
      estimatedTimeSeconds: circle.estimatedTimeSeconds,
      circleFeeBps: circle.feeBps,
      protocolFeeBps: protocol.feeBps,
      slippageBps: slippage.slippageBps,
      sourceGasUsd: usd(simulation.sourceGas.amountUsd),
      destinationGasUsd: usd(simulation.destinationGas.amountUsd),
      arcGasUsd: usd((input.sourceChain === "ARC" ? simulation.sourceGas.amountUsd : 0) + (input.destinationChain === "ARC" ? simulation.destinationGas.amountUsd : 0)),
      sourceGasAmount: nativeAmount(simulation.sourceGas.amount),
      sourceGasToken: simulation.sourceGas.token,
      destinationGasAmount: nativeAmount(simulation.destinationGas.amount),
      destinationGasToken: simulation.destinationGas.token,
      networkGasUsd: usd(userGasUsd),
      bridgeFeeUsd: usd(circle.feeUsd),
      protocolFeeUsd: usd(protocol.feeUsd),
      slippageUsd: usd(slippage.slippageUsd),
      paymasterSponsoredUsd: "0",
      paymasterSurchargeUsd: "0",
      userPaysUsd: usd(userPaysUsd),
      sourceDepositRequiredUsd: usd(routeKind === "GATEWAY" ? toNumber(input.amount, 0) + circle.feeUsd : toNumber(input.amount, 0)),
      totalEstimatedCostUsd: usd(totalEstimatedCostUsd),
      estimatedAmountToProtocol: simulation.protocolInputAmount,
      minimumReceived: simulation.minimumOutputAmount,
      outputTokenSymbol: output.symbol,
      receiptTokenSymbol: output.symbol,
      estimatedOutputAmount: output.estimatedAmount,
      minimumOutputAmount: output.minimumAmount,
      feeLines: lines,
      assumptions,
      warnings
    };
  }

  async alternatives(input: CreateIntentInput): Promise<RouteAlternative[]> {
    const candidates = this.candidateRoutes(input);
    const goal = this.optimizationGoal(input);
    const preferredRoute = input.preferredRoute && candidates.includes(input.preferredRoute)
      ? input.preferredRoute
      : undefined;

    if (preferredRoute) {
      const preferred = await this.quoteAlternative(input, preferredRoute, goal);
      const skipped = candidates
        .filter((routeKind) => routeKind !== preferredRoute)
        .map((routeKind) => this.skippedAlternative(input, routeKind));
      return [preferred, ...skipped].sort((a, b) => b.score - a.score);
    }

    const results = await Promise.all(candidates.map((routeKind) => this.quoteAlternative(input, routeKind, goal)));
    return results.sort((a, b) => b.score - a.score);
  }

  async select(input: CreateIntentInput): Promise<RouteAlternative> {
    const alternatives = await this.alternatives(input);
    const preferred = input.preferredRoute ? alternatives.find((alt) => alt.routeKind === input.preferredRoute && alt.eligible) : undefined;
    return preferred ?? alternatives.find((alt) => alt.eligible) ?? alternatives[0];
  }

  optimizationGoal(input: CreateIntentInput): OptimizationGoal {
    return input.optimizationGoal ?? (feeModel.defaultOptimizationGoal as OptimizationGoal | undefined) ?? "balanced";
  }

  private candidateRoutes(input: CreateIntentInput): RouteKind[] {
    if (input.sourceChain === input.destinationChain) return input.protocol === "ARC_GATEWAY" ? ["GATEWAY", "LOCAL"] : ["LOCAL"];
    const source = findChainByKey(input.sourceChain);
    const destination = findChainByKey(input.destinationChain);
    if (source.vm === "xrpl" || destination.vm === "xrpl") {
      return ["AXELAR_ITS"];
    }
    const routes: RouteKind[] = [];
    if (hasGatewayContracts(source) && hasGatewayContracts(destination)) routes.push("GATEWAY");
    routes.push("CCTP_V2");
    if (source.vm === "evm" && destination.vm === "evm") routes.push("BRIDGEKIT");
    return [...new Set(routes)];
  }

  private async quoteAlternative(input: CreateIntentInput, routeKind: RouteKind, goal: OptimizationGoal): Promise<RouteAlternative> {
    const eligibility = this.eligibility(input, routeKind);
    if (!eligibility.eligible) {
      const route = feeModel.routes?.[routeKind] ?? {};
      return {
        routeKind,
        eligible: false,
        score: 0,
        estimatedTimeSeconds: toNumber(route.estimatedTimeSeconds, 0),
        reason: "Route is not eligible for this intent.",
        rejectionReasons: eligibility.reasons
      };
    }

    try {
      const quote = await this.quote(input, routeKind);
      const score = this.score(input, quote, goal);
      return {
        routeKind,
        eligible: true,
        score,
        estimatedTimeSeconds: quote.estimatedTimeSeconds,
        feeQuote: quote,
        reason: this.reason(input, quote, score, goal),
        rejectionReasons: []
      };
    } catch (err) {
      const route = feeModel.routes?.[routeKind] ?? {};
      const message = err instanceof Error ? err.message : String(err);
      return {
        routeKind,
        eligible: false,
        score: 0,
        estimatedTimeSeconds: toNumber(route.estimatedTimeSeconds, 0),
        reason: "Route simulation failed.",
        rejectionReasons: [`Simulation unavailable: ${friendlySimulationError(message)}`]
      };
    }
  }

  private skippedAlternative(input: CreateIntentInput, routeKind: RouteKind): RouteAlternative {
    const route = feeModel.routes?.[routeKind] ?? {};
    const eligibility = this.eligibility(input, routeKind);
    return {
      routeKind,
      eligible: false,
      score: 0,
      estimatedTimeSeconds: toNumber(route.estimatedTimeSeconds, 0),
      reason: "Skipped during selected-route fast quote.",
      rejectionReasons: eligibility.eligible
        ? ["Not simulated because a specific preferred route was selected."]
        : eligibility.reasons
    };
  }

  private eligibility(input: CreateIntentInput, routeKind: RouteKind): EligibilityResult {
    const reasons: string[] = [];
    const source = findChainByKey(input.sourceChain);
    const destination = findChainByKey(input.destinationChain);
    const protocolChain = findProtocolWithChain(input.protocol).chainKey;

    if (routeKind === "LOCAL" && input.sourceChain !== input.destinationChain) reasons.push("Local execution requires source and destination chain to match.");
    if (input.destinationChain !== protocolChain) reasons.push(`Selected protocol ${input.protocol} is deployed on ${protocolChain}, not ${input.destinationChain}.`);
    if (routeKind === "GATEWAY" && !(hasGatewayContracts(source) && hasGatewayContracts(destination))) reasons.push("Gateway requires Gateway wallet and minter contracts on both source and destination.");
    if ((routeKind === "CCTP_V2" || routeKind === "BRIDGEKIT") && input.asset !== "USDC") reasons.push(`${routeKind} supports USDC in this scaffold. Use an Arc FX step for ${input.asset}.`);
    if ((routeKind === "CCTP_V2" || routeKind === "BRIDGEKIT") && (source.cctpDomain === undefined || destination.cctpDomain === undefined)) reasons.push("CCTP domain missing for source or destination chain.");
    if (routeKind === "BRIDGEKIT" && !(source.vm === "evm" && destination.vm === "evm")) reasons.push("BridgeKit route in this scaffold currently supports EVM-to-EVM execution only.");
    if (routeKind === "AXELAR_ITS" && source.vm !== "xrpl" && destination.vm !== "xrpl") reasons.push("Axelar ITS route in this scaffold supports XRPL VM chains only.");

    if (input.sourceChain === "RIPPLE") {
      if (input.protocol === "BASE_MORPHO_BLUE") {
        reasons.push("Morpho Blue does not support direct XRP deposits from Ripple Ledger; swap XRP to USDC first on Base.");
      }
      if (input.protocol === "ARC_USYC_TELLER") {
        reasons.push("USYC Teller does not support direct XRP deposits from Ripple Ledger; swap XRP to USDC first on Arc.");
      }
    }

    return { eligible: reasons.length === 0, reasons };
  }

  private score(input: CreateIntentInput, quote: FeeQuote, goal: OptimizationGoal): number {
    const weights = feeModel.routeWeights?.[goal] ?? feeModel.routeWeights?.balanced ?? { cost: 0.34, speed: 0.30, reliability: 0.26, compatibility: 0.10 };
    const amountUsd = Math.max(1, toNumber(input.amount, 1));
    const totalCostUsd = toNumber(quote.totalEstimatedCostUsd, 0);
    const costRatio = totalCostUsd / amountUsd;
    const costScore = clamp(100 - costRatio * 1_000, 0, 100);
    const speedScore = clamp(100 - Math.log10(Math.max(1, quote.estimatedTimeSeconds)) * 25, 0, 100);
    const route = feeModel.routes?.[quote.routeKind] ?? {};
    const reliabilityScore = toNumber(route.reliabilityScore, 80);
    const compatibilityScore = toNumber(route.compatibilityScore, 80);
    let score =
      toNumber(weights.cost, 0.34) * costScore +
      toNumber(weights.speed, 0.30) * speedScore +
      toNumber(weights.reliability, 0.26) * reliabilityScore +
      toNumber(weights.compatibility, 0.10) * compatibilityScore;

    const gatewayThreshold = toNumber(agentPolicies.preferGatewayUnderUsdc, 0);
    if (quote.routeKind === "GATEWAY" && toNumber(input.amount, 0) <= gatewayThreshold) score += 4;
    if (input.preferredRoute === quote.routeKind) score += 8;
    if (quote.confidence === "low") score -= 8;
    return Math.round(clamp(score, 0, 100) * 100) / 100;
  }

  private reason(input: CreateIntentInput, quote: FeeQuote, score: number, goal: OptimizationGoal): string {
    return `${quote.routeKind} scored ${score}/100 for ${goal}: user pays about ${quote.userPaysUsd} USDC, total system cost about ${quote.totalEstimatedCostUsd} USDC, ETA ${quote.estimatedTimeSeconds}s, product ${quote.circleProduct}.`;
  }

  private confidence(routeKind: RouteKind, warnings: string[]): FeeConfidence {
    if (warnings.length >= 4) return "low";
    if (routeKind === "LOCAL") return "high";
    if (routeKind === "GATEWAY" || routeKind === "BRIDGEKIT") return "medium";
    return warnings.length > 0 ? "medium" : "high";
  }

  private userGuardWarnings(input: CreateIntentInput, userPaysUsd: number, totalEstimatedCostUsd: number): string[] {
    const warnings: string[] = [];
    const maxFee = toNumber(input.maxTotalFeeUsd, NaN);
    if (Number.isFinite(maxFee) && totalEstimatedCostUsd > maxFee) {
      warnings.push(`Estimated total cost ${amount(totalEstimatedCostUsd)} exceeds user maxTotalFeeUsd ${input.maxTotalFeeUsd}.`);
    }
    if (userPaysUsd > toNumber(input.amount, 0) * 0.05 && toNumber(input.amount, 0) > 0) {
      warnings.push("User-paid cost is above 5% of transfer amount; consider a cheaper route or larger batch.");
    }
    return warnings;
  }

  private async outputEstimate(input: CreateIntentInput, estimatedAmount: string, minimumAmount: string, simulatedSymbol?: string): Promise<{ symbol: string; estimatedAmount: string; minimumAmount: string }> {
    if (input.action === "swap") {
      return {
        symbol: simulatedSymbol ?? this.resolveSwapOutputSymbol(input),
        estimatedAmount,
        minimumAmount
      };
    }

    if (input.action === "transfer" || input.protocol.endsWith("_USDC_TRANSFER")) {
      return {
        symbol: input.asset,
        estimatedAmount,
        minimumAmount
      };
    }

    if (simulatedSymbol) {
      return {
        symbol: simulatedSymbol,
        estimatedAmount,
        minimumAmount
      };
    }

    const { protocol } = findProtocolWithChain(input.protocol);
    const protocolType = String(protocol.type ?? "");
    if (protocolType.includes("lending")) {
      return {
        symbol: `${input.asset} position`,
        estimatedAmount,
        minimumAmount
      };
    }
    if (protocolType.includes("tokenized_cash")) {
      return {
        symbol: protocol.outputTokenSymbol ?? "USYC",
        estimatedAmount,
        minimumAmount
      };
    }

    return {
      symbol: input.asset,
      estimatedAmount,
      minimumAmount
    };
  }

  private resolveSwapOutputSymbol(input: CreateIntentInput): string {
    const explicit = typeof input.metadata?.tokenOutSymbol === "string" ? input.metadata.tokenOutSymbol.trim() : "";
    if (explicit) return explicit;

    const tokenOut = normalizeAddress(input.metadata?.tokenOut);
    const destination = findChainByKey(input.destinationChain);
    for (const [symbol, token] of Object.entries(destination.tokens ?? {}) as Array<[string, any]>) {
      const configuredAddress = normalizeAddress(token.address ?? token.contract ?? token.mint);
      if (configuredAddress && tokenOut && configuredAddress === tokenOut) return symbol;
    }
    if (tokenOut === "0x0000000000000000000000000000000000000000") {
      return String(destination.nativeCurrency?.symbol ?? "ETH").toUpperCase();
    }
    return input.asset;
  }

  private async convertUsdValueToOutputToken(symbol: string, estimatedAmount: string, minimumAmount: string): Promise<{ estimatedAmount: string; minimumAmount: string }> {
    const upper = symbol.toUpperCase();
    const estimatedUsd = toNumber(estimatedAmount, 0);
    const minimumUsd = toNumber(minimumAmount, 0);
    const stableSymbols = new Set(["USDC", "EURC", "USD"]);
    if (stableSymbols.has(upper) || upper.includes("POSITION")) {
      return { estimatedAmount, minimumAmount };
    }

    try {
      const prices = await liveQuoteService.getTokenPrices();
      const priceUsd = upper === "ETH" || upper === "WETH"
        ? prices.ethereum
        : upper === "SOL"
          ? prices.solana
          : upper === "XLM"
            ? prices.stellar
            : upper === "BTC" || upper === "CBBTC" || upper === "WBTC"
              ? prices.bitcoin
              : 0;
      if (priceUsd > 0) {
        return {
          estimatedAmount: outputAmount(estimatedUsd / priceUsd),
          minimumAmount: outputAmount(minimumUsd / priceUsd)
        };
      }
    } catch {
      // Keep the USD-sized amount if token pricing is unavailable.
    }

    return { estimatedAmount, minimumAmount };
  }
}
