import { BatchFacilitatorClient, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS } from "@circle-fin/x402-batching/server";
import { getAddress, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainConfig, env } from "../config/index.js";

export interface NanopaymentResource {
  path: string;
  priceUsdc: string;
  description: string;
}

type SupportedKind = {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: {
    name?: string;
    version?: string;
    verifyingContract?: string;
    assets?: Array<{ symbol?: string; address?: string; decimals?: number }>;
    [key: string]: unknown;
  };
};

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: {
    name: "GatewayWalletBatched";
    version: "1";
    verifyingContract: Address;
  };
};

export type PaymentRequiredChallenge = {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
    mimeType: "application/json";
  };
  accepts: PaymentRequirements[];
};

export class NanopaymentAgent {
  private resources = new Map<string, NanopaymentResource>();
  private facilitator = new BatchFacilitatorClient({ url: env.circleGatewayApiUrl });
  private supportedKinds?: SupportedKind[];

  readonly sellerAddress: Address;
  readonly feeReceiverSource: "RAUM_FEE_RECEIVER_ADDRESS" | "NANO_PAYMENT_SELLER_ADDRESS" | "AGENT_PRIVATE_KEY" | "OPERATOR_PRIVATE_KEY";

  constructor() {
    const configuredFeeReceiver = process.env.RAUM_FEE_RECEIVER_ADDRESS;
    const configuredSeller = process.env.NANO_PAYMENT_SELLER_ADDRESS;
    if (configuredFeeReceiver && isAddress(configuredFeeReceiver)) {
      this.sellerAddress = getAddress(configuredFeeReceiver);
      this.feeReceiverSource = "RAUM_FEE_RECEIVER_ADDRESS";
    } else if (configuredSeller && isAddress(configuredSeller)) {
      this.sellerAddress = getAddress(configuredSeller);
      this.feeReceiverSource = "NANO_PAYMENT_SELLER_ADDRESS";
    } else if (env.agentPrivateKey) {
      this.sellerAddress = privateKeyToAccount(env.agentPrivateKey as `0x${string}`).address;
      this.feeReceiverSource = "AGENT_PRIVATE_KEY";
    } else if (env.operatorPrivateKey) {
      this.sellerAddress = privateKeyToAccount(env.operatorPrivateKey as `0x${string}`).address;
      this.feeReceiverSource = "OPERATOR_PRIVATE_KEY";
    } else {
      throw new Error("Set RAUM_FEE_RECEIVER_ADDRESS, NANO_PAYMENT_SELLER_ADDRESS, AGENT_PRIVATE_KEY, or OPERATOR_PRIVATE_KEY before enabling live nanopayments.");
    }
  }

  createResource(resource: NanopaymentResource): NanopaymentResource {
    this.resources.set(resource.path, resource);
    return resource;
  }

  getResource(path: string): NanopaymentResource | undefined {
    return this.resources.get(path);
  }

  listResources(): NanopaymentResource[] {
    return [...this.resources.values()];
  }

  acceptedNetworkIds(): string[] {
    const configuredNetworks = (process.env.X402_ACCEPTED_NETWORKS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const allowed = configuredNetworks.length > 0
      ? new Set(configuredNetworks.map((item) => item.startsWith("eip155:") ? item : networkIdForChainKey(item)).filter(Boolean))
      : undefined;

    return Object.values(chainConfig)
      .filter((chain: any) => chain.vm === "evm" && chain.circle?.gateway?.nanopayments && chain.chainId)
      .map((chain: any) => `eip155:${chain.chainId}`)
      .filter((network) => !allowed || allowed.has(network));
  }

  async createPaymentRequired(path: string): Promise<PaymentRequiredChallenge> {
    const resource = this.resources.get(path);
    if (!resource) throw new Error(`Nanopayment resource is not registered: ${path}`);

    const accepts = await this.createPaymentRequirements(resource);
    if (accepts.length === 0) {
      throw new Error("Circle Gateway returned no supported x402 batching networks for this app.");
    }

    return {
      x402Version: 2,
      resource: {
        url: path,
        description: resource.description,
        mimeType: "application/json"
      },
      accepts
    };
  }

  async describeChallenge(path: string): Promise<Record<string, unknown>> {
    const resource = this.resources.get(path);
    const paymentRequired = await this.createPaymentRequired(path);
    return {
      scheme: "x402",
      protocol: "Circle Gateway batched EIP-3009",
      header: "Payment-Signature",
      asset: "USDC",
      price: resource?.priceUsdc ?? "0",
      amount: priceToUsdcUnits(resource?.priceUsdc ?? "0").toString(),
      payTo: this.sellerAddress,
      feeReceiver: this.sellerAddress,
      feeReceiverSource: this.feeReceiverSource,
      accepts: paymentRequired.accepts,
      paymentRequired,
      paymentRequiredHeader: Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
      memo: "Sign a GatewayWalletBatched EIP-712 authorization from the connected wallet. Circle x402 settles the relayer/API fee to the Raum fee receiver, then retries the paid endpoint with the Payment-Signature header."
    };
  }

  private async createPaymentRequirements(resource: NanopaymentResource): Promise<PaymentRequirements[]> {
    const supportedKinds = await this.getSupportedKinds();
    const amount = priceToUsdcUnits(resource.priceUsdc).toString();
    const accepted = this.acceptedNetworkIds();

    return accepted.flatMap((network) => {
      const kind = supportedKinds.find((candidate) => candidate.network === network);
      const verifyingContract = kind?.extra?.verifyingContract;
      if (!kind || kind.scheme !== "exact" || !verifyingContract || !isAddress(verifyingContract)) {
        return [];
      }

      const asset = kind.extra?.assets?.find((candidate) => candidate.symbol === "USDC")?.address
        ?? this.usdcForNetwork(network);
      if (!asset || !isAddress(asset)) return [];

      return [{
        scheme: "exact" as const,
        network,
        asset: getAddress(asset),
        amount,
        payTo: this.sellerAddress,
        maxTimeoutSeconds: GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
        extra: {
          name: "GatewayWalletBatched" as const,
          version: "1" as const,
          verifyingContract: getAddress(verifyingContract)
        }
      }];
    });
  }

  private async getSupportedKinds(): Promise<SupportedKind[]> {
    if (!this.supportedKinds) {
      const supported = await this.facilitator.getSupported();
      this.supportedKinds = supported.kinds as SupportedKind[];
    }
    return this.supportedKinds;
  }

  private usdcForNetwork(network: string): string | undefined {
    const chainId = network.replace("eip155:", "");
    const chain = Object.values(chainConfig).find((candidate: any) => String(candidate.chainId) === chainId) as any;
    return chain?.tokens?.USDC?.address;
  }
}

export function priceToUsdcUnits(price: string): bigint {
  const [whole, fraction = ""] = price.split(".");
  const padded = `${fraction}000000`.slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0");
}

function networkIdForChainKey(chainKey: string): string | undefined {
  const chain = Object.values(chainConfig).find((candidate: any) => candidate.key === chainKey) as any;
  return chain?.chainId ? `eip155:${chain.chainId}` : undefined;
}

export const nanopaymentAgent = new NanopaymentAgent();
nanopaymentAgent.createResource({ path: "/paid/protocol-score", priceUsdc: "0.000001", description: "AI generated protocol score for a target chain." });
nanopaymentAgent.createResource({ path: "/paid/route-alpha", priceUsdc: "0.005", description: "AI generated route recommendation." });
