import { feeModel, findProtocolWithChain } from "../../config/index.js";
import { CreateIntentInput, FeeLineItem } from "../../types.js";
import { amount, bpsOf, toNumber, usd } from "./math.js";

export interface SlippageEstimate {
  slippageBps: number;
  slippageUsd: number;
  minimumReceived: string;
  estimatedAmountToProtocol: string;
  lines: FeeLineItem[];
  warnings: string[];
  assumptions: string[];
}

export class SlippageEstimator {
  estimate(input: CreateIntentInput, nonGasFeesUsd: number): SlippageEstimate {
    const { protocol } = findProtocolWithChain(input.protocol);
    const protocolType = protocol.type ?? "unknown";
    const model = feeModel.protocolFees?.[protocolType] ?? { defaultSlippageBps: 0, minReceivedBufferBps: 0 };
    const amountUsd = toNumber(input.amount, 0);
    const isMarketPriced = protocolType.includes("dex") || protocolType === "fx";
    const slippageBps = isMarketPriced ? input.slippageBps ?? toNumber(model.defaultSlippageBps, 0) : 0;
    const minReceivedBufferBps = isMarketPriced ? toNumber(model.minReceivedBufferBps, 0) : 0;
    const slippageUsd = bpsOf(amountUsd, slippageBps);
    const bufferUsd = bpsOf(amountUsd, minReceivedBufferBps);
    const estimatedAmountToProtocol = Math.max(0, amountUsd - nonGasFeesUsd - slippageUsd);
    const minimumReceived = Math.max(0, estimatedAmountToProtocol - bufferUsd);
    const warnings: string[] = [];
    const assumptions = [isMarketPriced
      ? `Slippage model uses ${slippageBps} bps tolerance and ${minReceivedBufferBps} bps min-received buffer.`
      : `Slippage ignored for ${protocolType} because the selected action is not a swap or FX trade.`
    ];

    if (isMarketPriced && slippageBps > 100) warnings.push("Slippage tolerance is above 1%; require extra review for production execution.");

    const lines: FeeLineItem[] = slippageUsd > 0 ? [{
      key: "slippage_cost",
      label: "Estimated slippage / price impact",
      chargedBy: "protocol",
      payer: "user",
      amount: usd(slippageUsd),
      currency: input.asset,
      amountUsd: usd(slippageUsd),
      isEstimate: true,
      notes: ["Economic cost, not a direct protocol fee. Replace with live quoter output in production."]
    }] : [];

    return {
      slippageBps,
      slippageUsd,
      minimumReceived: amount(minimumReceived),
      estimatedAmountToProtocol: amount(estimatedAmountToProtocol),
      lines,
      warnings,
      assumptions
    };
  }
}
