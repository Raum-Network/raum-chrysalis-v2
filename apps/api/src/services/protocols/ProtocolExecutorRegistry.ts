import { ProtocolActionPayload } from "../../agents/ProtocolActionAgent.js";
import { RoutePlan } from "../../types.js";
import { EvmProtocolExecutor } from "./evmProtocolExecutor.js";
import { KaminoLendService } from "./solanaKamino.js";
import { RaydiumService } from "./solanaRaydium.js";
import { MarinadeService } from "./solanaMarinade.js";
import { AquariusService } from "./stellarAquarius.js";
import { BlendCapitalService } from "./stellarBlend.js";

export class ProtocolExecutorRegistry {
  private evm = new EvmProtocolExecutor();
  private kamino = new KaminoLendService();
  private raydium = new RaydiumService();
  private marinade = new MarinadeService();
  private aquarius = new AquariusService();
  private blend = new BlendCapitalService();

  async execute(plan: RoutePlan, payload: ProtocolActionPayload): Promise<Record<string, unknown>> {
    if (payload.executionMode === "bridge-only") {
      return {
        status: "succeeded",
        executable: true,
        chain: plan.destinationChain,
        protocol: plan.protocol,
        action: "transfer",
        executedAmountUsdc: plan.executionAmount ?? plan.amount,
        amountOutFormatted: plan.executionAmount ?? plan.amount,
        amountOutSymbol: "USDC",
        recipient: plan.recipient,
        note: "Bridge-only transfer complete; no protocol adapter execution was required."
      };
    }
    if (payload.executionMode === "evm-contract") return this.evm.execute(plan, payload);
    if (payload.protocol === "SOL_KAMINO_LEND") return this.kamino.buildAndMaybeSubmit(payload.serviceAction ?? {});
    if (payload.protocol === "SOL_RAYDIUM_CPMM") return this.raydium.buildAndMaybeSubmit(payload.serviceAction ?? {});
    if (payload.protocol === "SOL_MARINADE") return this.marinade.buildAndMaybeSubmit(payload.serviceAction ?? {});
    if (payload.protocol === "XLM_AQUARIUS") return this.aquarius.buildAndMaybeSubmit(payload.serviceAction ?? {});
    if (payload.protocol === "XLM_BLEND") return this.blend.buildAndMaybeSubmit(payload.serviceAction ?? {});
    if (payload.executionMode === "x402") return { status: "configured", payload };
    return { status: "skipped", reason: "No executor registered.", payload };
  }
}
