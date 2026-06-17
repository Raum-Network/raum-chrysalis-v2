import { agentPolicies, findChainByKey, findProtocolWithChain } from "../config/index.js";
import { CreateIntentInput } from "../types.js";

export interface PolicyDecision {
  allowed: boolean;
  requiresHumanApproval: boolean;
  reasons: string[];
}

export class RiskPolicyAgent {
  evaluate(input: CreateIntentInput): PolicyDecision {
    const reasons: string[] = [];
    const amount = Number(input.amount);
    const maxSingle = Number(agentPolicies.maxSingleIntentUsdc ?? 25);
    const hardMaxSingle = Number(agentPolicies.hardMaxSingleIntentUsdc ?? 1000);
    const approvalThreshold = Number(agentPolicies.requireHumanApprovalOverUsdc ?? maxSingle);
    const allowedChains = new Set<string>(agentPolicies.allowedChains ?? []);
    const allowedProtocols = new Set<string>(agentPolicies.allowedProtocols ?? []);
    const maxSlippageBps = Number(agentPolicies.maxSlippageBps ?? 75);

    if (!allowedChains.has(input.sourceChain)) reasons.push(`Source chain ${input.sourceChain} is not allowlisted.`);
    if (!allowedChains.has(input.destinationChain)) reasons.push(`Destination chain ${input.destinationChain} is not allowlisted.`);
    if (!allowedProtocols.has(input.protocol)) reasons.push(`Protocol ${input.protocol} is not allowlisted.`);
    if (amount <= 0 || !Number.isFinite(amount)) reasons.push("Amount must be a positive number.");
    if (amount > hardMaxSingle) reasons.push(`Amount ${input.amount} exceeds hard single-intent cap ${hardMaxSingle}.`);
    if ((input.slippageBps ?? 0) > maxSlippageBps) reasons.push(`Slippage ${input.slippageBps} bps exceeds max ${maxSlippageBps} bps.`);

    try {
      const destination = findChainByKey(input.destinationChain);
      if (!destination.tokens?.[input.asset]) reasons.push(`${input.asset} is not configured on destination chain ${input.destinationChain}.`);
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }

    try {
      const { chainKey } = findProtocolWithChain(input.protocol);
      if (chainKey !== input.destinationChain) {
        reasons.push(`Protocol ${input.protocol} is deployed on ${chainKey}, but destination chain is ${input.destinationChain}.`);
      }
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }

    const userPaysCap = Number(input.maxTotalFeeUsd ?? agentPolicies.maxUserPaysUsd ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(userPaysCap) && userPaysCap < 0) reasons.push("maxTotalFeeUsd must be positive when provided.");

    return {
      allowed: reasons.length === 0,
      requiresHumanApproval: amount > approvalThreshold || amount > maxSingle || input.autonomous !== true,
      reasons
    };
  }
}
