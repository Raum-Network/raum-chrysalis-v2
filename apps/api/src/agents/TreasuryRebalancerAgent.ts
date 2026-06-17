import { CreateIntentInput } from "../types.js";
import { agentPolicies } from "../config/index.js";
import { RoutePlannerAgent } from "./RoutePlannerAgent.js";

export class TreasuryRebalancerAgent {
  constructor(private readonly planner = new RoutePlannerAgent()) {}

  async proposeRebalance(mockBalances: Record<string, number>): Promise<{ shouldRebalance: boolean; intent?: CreateIntentInput; reason: string }> {
    const minArc = Number(agentPolicies.autonomousMode?.rebalanceMinArcUsdc ?? 50);
    const targetArc = Number(agentPolicies.autonomousMode?.rebalanceTargetArcUsdc ?? 150);
    const arcBalance = mockBalances.ARC ?? 0;

    if (arcBalance >= minArc) {
      return { shouldRebalance: false, reason: `Arc balance ${arcBalance} is above minimum ${minArc}.` };
    }

    const source = Object.entries(mockBalances)
      .filter(([chain]) => chain !== "ARC")
      .sort((a, b) => b[1] - a[1])[0];

    if (!source || source[1] <= 0) {
      return { shouldRebalance: false, reason: "No source chain has surplus USDC." };
    }

    const amount = Math.min(targetArc - arcBalance, source[1]).toFixed(2);
    const intent: CreateIntentInput = {
      sourceChain: source[0],
      destinationChain: "ARC",
      asset: "USDC",
      amount,
      protocol: "ARC_GATEWAY",
      action: "rebalance-to-arc",
      autonomous: true
    };

    const plan = await this.planner.plan(intent);
    return { shouldRebalance: !plan.requiresHumanApproval, intent, reason: plan.rationale.join(" ") };
  }
}
