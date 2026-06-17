import { feeModel, findChainByKey, env } from "../../config/index.js";
import { CreateIntentInput, FeeLineItem, RouteKind } from "../../types.js";
import { bpsOf, toNumber, usd } from "./math.js";
import { liveQuoteService } from "./liveQuoteService.js";
import { estimateGatewayMaxFeeUsdc } from "./gatewayFee.js";

export interface CircleFeeEstimate {
  circleProduct: string;
  feeBps: number;
  feeUsd: number;
  estimatedTimeSeconds: number;
  lines: FeeLineItem[];
  warnings: string[];
  assumptions: string[];
}

const ROUTE_ESTIMATED_TIME_SECONDS: Partial<Record<RouteKind, number>> = {
  GATEWAY: 10,
  CCTP_V2: 21,
  BRIDGEKIT: 32
};

function routeEstimatedTimeSeconds(routeKind: RouteKind, fallback: number): number {
  return ROUTE_ESTIMATED_TIME_SECONDS[routeKind] ?? fallback;
}

export class CircleFeeEstimator {
  async estimate(input: CreateIntentInput, routeKind: RouteKind): Promise<CircleFeeEstimate> {
    const route = feeModel.routes?.[routeKind] ?? {};
    const amountUsd = toNumber(input.amount, 0);
    const source = findChainByKey(input.sourceChain);
    const destination = findChainByKey(input.destinationChain);
    const cctpMode = String(input.metadata?.cctpMode ?? input.metadata?.finality ?? "standard");
    const wantsFast = cctpMode.toLowerCase() === "fast" || input.metadata?.fastTransfer === true;
    let feeBps = 0;
    let circleProduct = route.circleProduct ?? routeKind;
    let estimatedTimeSeconds = toNumber(route.estimatedTimeSeconds, 60);
    const warnings: string[] = [...(route.warnings ?? [])];
    const assumptions: string[] = [];

    if (routeKind === "LOCAL" || routeKind === "MOCK") {
      circleProduct = "None";
      feeBps = 0;
      estimatedTimeSeconds = toNumber(route.estimatedTimeSeconds, 5);
    } else if (routeKind === "GATEWAY") {
      circleProduct = "Gateway";
      // Try live Gateway transfer fee via Circle Iris (Gateway settles over CCTP domains).
      let liveGatewayBps: number | null = null;
      if (env.liveFees && source.cctpDomain !== undefined && destination.cctpDomain !== undefined) {
        liveGatewayBps = await liveQuoteService.getCctpLiveFeeBps(source.cctpDomain, destination.cctpDomain, true);
      }
      if (liveGatewayBps !== null) {
        feeBps = liveGatewayBps;
        assumptions.push(`Gateway transfer fee retrieved live from Circle Iris API (feeBps: ${feeBps}).`);
      } else {
        feeBps = env.gatewayTransferFeeBps;
        assumptions.push(`Gateway transfer fee: static fallback ${feeBps} bps (set CIRCLE_API_KEY to get live Iris rates).`);
      }
    } else if (routeKind === "CCTP_V2" || routeKind === "BRIDGEKIT") {
      circleProduct = routeKind === "BRIDGEKIT"
        ? (wantsFast ? "BridgeKit over CCTP Fast Transfer" : "BridgeKit over CCTP Standard Transfer")
        : (wantsFast ? "CCTP V2 Fast Transfer" : "CCTP V2 Standard Transfer");

      let liveFeeBps: number | null = null;
      if (env.liveFees && source.cctpDomain !== undefined && destination.cctpDomain !== undefined) {
        liveFeeBps = await liveQuoteService.getCctpLiveFeeBps(source.cctpDomain, destination.cctpDomain, wantsFast);
      }

      if (liveFeeBps !== null) {
        feeBps = liveFeeBps;
        assumptions.push(`Circle CCTP fee retrieved live from Circle Iris API (feeBps: ${feeBps}).`);
      } else {
        const fallbackBps = wantsFast ? env.cctpFastTransferFeeBps : 0;
        const cctpRoute = feeModel.routes?.CCTP_V2 ?? {};
        feeBps = wantsFast
          ? toNumber(cctpRoute.fastFeeBpsBySourceChain?.[input.sourceChain], fallbackBps)
          : toNumber(cctpRoute.standardFeeBps, 0);
        assumptions.push(wantsFast ? "Fast Transfer fee fell back to static config (set CIRCLE_API_KEY to get live Iris rates)." : "Standard CCTP route: zero Circle transfer fee.");
        // Only warn when using fallback for fast transfers (where fee is non-zero and uncertain)
        if (wantsFast) {
          warnings.push("Fast Transfer fee uses static fallback — set CIRCLE_API_KEY to fetch live rates from Circle Iris.");
        }
      }

      estimatedTimeSeconds = wantsFast ? toNumber(route.fastEstimatedTimeSeconds, estimatedTimeSeconds) : estimatedTimeSeconds;

      if (routeKind === "BRIDGEKIT") {
        const serviceFee = wantsFast ? 0 : env.bridgekitUnderlyingFeeBps;
        feeBps += serviceFee;
        assumptions.push("BridgeKit is treated as the orchestration SDK around CCTP in the local model.");
      }
    }

    if (input.asset !== "USDC" && routeKind !== "LOCAL") {
      warnings.push(`${routeKind} quote is only reliable for USDC. ${input.asset} may require a local Arc EURC/FX step first.`);
    }

    if (source.cctpDomain === undefined || destination.cctpDomain === undefined) {
      warnings.push("One side of this route is missing a configured CCTP domain.");
    }

    if (!env.circleApiKey) {
      assumptions.push("Circle API key not configured — Circle Iris fee APIs are skipped; static fee-model values are used.");
    }

    let feeUsd = bpsOf(amountUsd, feeBps);
    if (routeKind === "GATEWAY") {
      feeUsd = estimateGatewayMaxFeeUsdc({
        amountUsdc: amountUsd,
        sourceChain: input.sourceChain,
        destinationChain: input.destinationChain
      });
    }

    const lines: FeeLineItem[] = feeUsd > 0 ? [{
      key: "circle_transfer_fee",
      label: `${circleProduct} fee`,
      chargedBy: "circle",
      payer: "user",
      amount: usd(feeUsd),
      currency: "USDC",
      amountUsd: usd(feeUsd),
      isEstimate: true,
      notes: routeKind === "GATEWAY"
        ? ["Included in the source-chain depositor funding amount."]
        : [`Mode: ${cctpMode}. Fee bps: ${feeBps}.`]
    }] : [{
      key: "circle_transfer_fee",
      label: `${circleProduct} fee`,
      chargedBy: "circle",
      payer: "not_applicable",
      amount: "0",
      currency: "USDC",
      amountUsd: "0",
      isEstimate: true,
      notes: ["No Circle transfer fee is modeled for this route/mode."]
    }];

    estimatedTimeSeconds = routeEstimatedTimeSeconds(routeKind, estimatedTimeSeconds);

    return { circleProduct, feeBps, feeUsd, estimatedTimeSeconds, lines, warnings, assumptions };
  }
}
