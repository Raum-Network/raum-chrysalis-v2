import { IntentReceipt } from "../types.js";
import { safeJsonStringify } from "../utils/json.js";

export class JudgeNarratorAgent {
  narrate(receipt: IntentReceipt): string {
    const plan = receipt.plan;
    const quote = plan?.feeQuote;
    const decision = plan?.intentDecision;
    const parts = [
      `Intent ${receipt.id} plans ${receipt.input.amount} ${receipt.input.asset} from ${receipt.input.sourceChain} to ${receipt.input.destinationChain}.`,
      plan ? `Selected route: ${plan.routeKind}${quote ? ` using ${quote.circleProduct}` : ""}.` : "Routing method was not available.",
      decision ? `Selection reason: ${decision.reason}` : undefined,
      `Target protocol: ${receipt.input.protocol}, action: ${receipt.input.action}.`,
      quote ? `Estimated user-paid cost: ${quote.userPaysUsd} USDC. Total system cost: ${quote.totalEstimatedCostUsd} USDC. Minimum received/deployed amount: ${quote.minimumReceived} ${receipt.input.asset}.` : undefined,
      quote?.feeLines?.length ? `Fee lines: ${quote.feeLines.map((line) => `${line.label}=${line.amountUsd} ${quote.quoteCurrency} paid by ${line.payer}`).join("; ")}.` : undefined,
      decision?.alternativesConsidered?.length ? `Alternatives considered: ${decision.alternativesConsidered.map((alt) => `${alt.routeKind}${alt.eligible ? ` score ${alt.score}` : ` rejected (${alt.rejectionReasons.join(", ")})`}`).join("; ")}.` : undefined,
      receipt.bridgeReceipt ? `Bridge receipt: ${safeJsonStringify(receipt.bridgeReceipt)}.` : "Bridge step is pending, skipped, or mocked.",
      receipt.protocolReceipt ? `Protocol receipt: ${safeJsonStringify(receipt.protocolReceipt)}.` : "Protocol step is pending or mocked.",
      "Risk policy checked chain allowlist, protocol allowlist, amount cap, slippage limits, route eligibility, and user fee guards before execution."
    ].filter(Boolean);
    return parts.join("\n");
  }
}
