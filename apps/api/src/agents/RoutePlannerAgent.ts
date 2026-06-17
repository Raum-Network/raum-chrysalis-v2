import { agentPolicies, findChainByKey } from "../config/index.js";
import { CreateIntentInput, IntentDecision, RoutePlan, RouteKind } from "../types.js";
import { FeeQuoteAgent } from "./FeeQuoteAgent.js";
import { RiskPolicyAgent } from "./policies.js";

export class RoutePlannerAgent {
  constructor(
    private readonly risk = new RiskPolicyAgent(),
    private readonly quoteAgent = new FeeQuoteAgent()
  ) {}

  async plan(input: CreateIntentInput): Promise<RoutePlan> {
    const source = findChainByKey(input.sourceChain);
    const destination = findChainByKey(input.destinationChain);
    const risk = this.risk.evaluate(input);
    const alternatives = await this.quoteAgent.alternatives(input);
    const hasGatewayExecutionPayload = Boolean(
      input.metadata?.gatewayBurnIntent && input.metadata?.gatewaySignature
    );
    const requiredRoute: RouteKind | undefined = hasGatewayExecutionPayload ? "GATEWAY" : input.preferredRoute;
    const requiredAlternative = requiredRoute ? alternatives.find((alt) => alt.routeKind === requiredRoute) : undefined;
    const selected = requiredRoute
      ? requiredAlternative
      : alternatives.find((alt) => alt.eligible) ?? alternatives[0];
    const amount = Number(input.amount);
    const goal = this.quoteAgent.optimizationGoal(input);
    let routeKind: RouteKind = selected?.routeKind ?? "MOCK";
    const rationale: string[] = [];

    if (source.key === destination.key) {
      rationale.push("Source and destination are the same chain, so the local route was considered first.");
    }

    if (requiredRoute && requiredAlternative?.eligible) {
      rationale.push(
        hasGatewayExecutionPayload
          ? "Gateway execution metadata was provided, so the Gateway route is required."
          : `User-selected preferred route ${requiredRoute} was honored.`
      );
    }

    if (requiredRoute && !requiredAlternative) {
      routeKind = "MOCK";
      rationale.push(`Requested route ${requiredRoute} is not available for this intent, so the plan is set to MOCK and requires review.`);
    } else if (selected?.eligible && selected.feeQuote) {
      if (!requiredRoute) rationale.push(`AI selected ${selected.routeKind} using the ${goal} optimization goal.`);
      rationale.push(selected.reason);
      rationale.push(`User-paid estimate: ${selected.feeQuote.userPaysUsd} USDC; total system cost: ${selected.feeQuote.totalEstimatedCostUsd} USDC; minimum received: ${selected.feeQuote.minimumReceived} ${input.asset}.`);
      if (selected.feeQuote.warnings.length > 0) rationale.push(...selected.feeQuote.warnings.map((warning) => `Fee warning: ${warning}`));
    } else {
      routeKind = "MOCK";
      rationale.push(requiredRoute
        ? `Requested route ${requiredRoute} is not eligible, so the plan is set to MOCK and requires review.`
        : "No eligible route was found, so the plan is set to MOCK and requires review.");
      if (selected) rationale.push(...selected.rejectionReasons);
    }

    if (amount <= Number(agentPolicies.preferGatewayUnderUsdc ?? 100) && selected?.eligible && selected?.routeKind === "GATEWAY") {
      rationale.push("Gateway preference was reinforced because the amount is under the configured small-transfer threshold.");
    }

    if (!risk.allowed) rationale.push(...risk.reasons);
    if (risk.requiresHumanApproval) rationale.push("Human approval is required by policy before execution.");

    const quoteExceededUserMax = Boolean(selected?.feeQuote?.warnings.some((warning) => warning.includes("maxTotalFeeUsd")));
    if (quoteExceededUserMax) rationale.push("Human approval is required because the fee quote exceeds the user-defined maxTotalFeeUsd guard.");

    const requiresHumanApproval = risk.requiresHumanApproval || !risk.allowed || !selected?.eligible || quoteExceededUserMax;
    const decision: IntentDecision = {
      selectedRoute: risk.allowed && selected?.eligible ? routeKind : "MOCK",
      selectedProtocol: input.protocol,
      selectedAction: input.action,
      optimizationGoal: goal,
      score: selected?.score ?? 0,
      reason: selected?.reason ?? "No eligible route selected.",
      approvalRequired: requiresHumanApproval,
      alternativesConsidered: alternatives.map((alt) => ({
        routeKind: alt.routeKind,
        eligible: alt.eligible,
        score: alt.score,
        userPaysUsd: alt.feeQuote?.userPaysUsd,
        totalEstimatedCostUsd: alt.feeQuote?.totalEstimatedCostUsd,
        estimatedTimeSeconds: alt.estimatedTimeSeconds,
        reason: alt.reason,
        rejectionReasons: alt.rejectionReasons
      }))
    };

    return {
      routeKind: risk.allowed && selected?.eligible ? routeKind : "MOCK",
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain,
      protocol: input.protocol,
      action: input.action,
      amount: input.amount,
      asset: input.asset,
      recipient: input.recipient,
      requiresHumanApproval,
      rationale,
      feeQuote: selected?.feeQuote,
      alternatives,
      intentDecision: decision,
      steps: [
        { label: "Validate policy, spend limits, and user fee guard", tool: "RiskPolicyAgent", status: "ready" },
        { label: "Compare Gateway, CCTP, BridgeKit, and local routes", tool: "FeeQuoteAgent", status: "ready" },
        { label: "Bridge or source unified balance", tool: routeKind, status: routeKind === "LOCAL" ? "ready" : "pending" },
        { label: "Execute protocol adapter", tool: input.protocol, status: "pending" },
        { label: "Record receipt and narration", tool: "JudgeNarratorAgent", status: "pending" }
      ]
    };
  }
}
