import { findChainByKey } from "../../config/index.js";

export interface PaymasterQuoteInput {
  chainKey: string;
  userOperation: Record<string, unknown>;
  entryPointVersion: "0.7" | "0.8";
}

export class CirclePaymasterService {
  getPaymasterAddress(chainKey: string, version: "0.7" | "0.8"): string | undefined {
    const chain = findChainByKey(chainKey);
    return version === "0.8" ? chain.circle?.paymaster?.v08 : chain.circle?.paymaster?.v07;
  }

  async sponsorUserOperation(input: PaymasterQuoteInput): Promise<Record<string, unknown>> {
    const paymaster = this.getPaymasterAddress(input.chainKey, input.entryPointVersion);
    if (!paymaster) return { supported: false, reason: `No Circle paymaster configured for ${input.chainKey}` };
    return {
      supported: true,
      paymaster,
      entryPointVersion: input.entryPointVersion,
      note: "Wire this into your ERC-4337 bundler request and Circle Paymaster policy."
    };
  }
}
