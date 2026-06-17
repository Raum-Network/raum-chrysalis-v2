import { CreateIntentInput, FeeQuote, RouteAlternative, RoutePlan } from "../types.js";
import { FeeQuoteAgent } from "./FeeQuoteAgent.js";
import { ProtocolActionAgent, ProtocolActionPayload } from "./ProtocolActionAgent.js";
import { RoutePlannerAgent } from "./RoutePlannerAgent.js";
import { RiskPolicyAgent, PolicyDecision } from "./policies.js";

export class AgentManager {
  private readonly risk = new RiskPolicyAgent();
  private readonly quoteAgent = new FeeQuoteAgent();
  private readonly planner = new RoutePlannerAgent(this.risk, this.quoteAgent);
  private readonly actionAgent = new ProtocolActionAgent();

  async analyze(input: CreateIntentInput): Promise<{ policy: PolicyDecision; plan: RoutePlan; actionPayload: ProtocolActionPayload }> {
    const policy = this.risk.evaluate(input);
    const plan = await this.planner.plan(input);
    const actionPayload = this.actionAgent.build(input);
    return { policy, plan, actionPayload };
  }

  async quote(input: CreateIntentInput): Promise<{ selected: FeeQuote | undefined; alternatives: RouteAlternative[]; plan: RoutePlan }> {
    const plan = await this.planner.plan(input);
    return { selected: plan.feeQuote, alternatives: plan.alternatives, plan };
  }
}

export const agentManager = new AgentManager();
