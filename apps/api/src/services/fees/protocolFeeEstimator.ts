import { feeModel, findProtocolWithChain, env } from "../../config/index.js";
import { CreateIntentInput, FeeLineItem } from "../../types.js";
import { bpsOf, toNumber, usd } from "./math.js";

export interface ProtocolFeeEstimate {
  feeBps: number;
  feeUsd: number;
  lines: FeeLineItem[];
  warnings: string[];
  assumptions: string[];
}

function feeBpsFromMetadata(input: CreateIntentInput): number | undefined {
  if (typeof input.metadata?.protocolFeeBps === "number") return input.metadata.protocolFeeBps;
  if (typeof input.metadata?.feeBps === "number") return input.metadata.feeBps;
  if (typeof input.metadata?.fee === "number") {
    // Uniswap-style fee tiers use hundredths of a basis point: 500 = 5 bps = 0.05%.
    return input.metadata.fee / 100;
  }
  return undefined;
}

export class ProtocolFeeEstimator {
  estimate(input: CreateIntentInput): ProtocolFeeEstimate {
    const { protocol } = findProtocolWithChain(input.protocol);
    const protocolType = protocol.type ?? "unknown";
    const model = feeModel.protocolFees?.[protocolType] ?? { defaultProtocolFeeBps: 0 };
    const amountUsd = toNumber(input.amount, 0);

    // Match by protocol key (keys are namespaced, e.g. SOL_KAMINO_LEND, ETH_AAVE_V3),
    // falling back to the protocol type model when no specific override exists.
    let fallbackBps = toNumber(model.defaultProtocolFeeBps, 0);
    if (input.protocol.includes("KAMINO")) {
      fallbackBps = env.kaminoEstimatedFeeBps;
    } else if (input.protocol.includes("RAYDIUM")) {
      fallbackBps = env.raydiumEstimatedFeeBps;
    } else if (input.protocol.includes("AQUARIUS")) {
      fallbackBps = env.aquariusEstimatedFeeBps;
    } else if (input.protocol.includes("USYC")) {
      fallbackBps = env.usycTellerEstimatedFeeBps;
    }

    const feeBps = feeBpsFromMetadata(input) ?? fallbackBps;
    const feeUsd = bpsOf(amountUsd, feeBps);
    const warnings: string[] = [...(model.warnings ?? [])];
    const assumptions = [`Protocol fee model: ${protocol.name ?? protocol.key} (${protocolType}).`];

    if (protocolType.includes("dex") && feeBps === 0) {
      warnings.push("DEX fee is zero in metadata/model; verify pool fee before live execution.");
    }

    const lines: FeeLineItem[] = feeUsd > 0 ? [{
      key: "protocol_fee",
      label: `${protocol.name ?? input.protocol} protocol/pool fee`,
      chargedBy: "protocol",
      payer: "user",
      amount: usd(feeUsd),
      currency: input.asset,
      amountUsd: usd(feeUsd),
      isEstimate: true,
      notes: [`Estimated with ${feeBps} bps.`]
    }] : [{
      key: "protocol_fee",
      label: `${protocol.name ?? input.protocol} protocol fee`,
      chargedBy: "protocol",
      payer: "not_applicable",
      amount: "0",
      currency: input.asset,
      amountUsd: "0",
      isEstimate: true,
      notes: ["No protocol fee is modeled for this action."]
    }];

    return { feeBps, feeUsd, lines, warnings, assumptions };
  }
}
