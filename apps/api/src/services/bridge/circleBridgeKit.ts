import { optionalImport } from "../../utils/optionalImport.js";
import { env, findChainByKey } from "../../config/index.js";
import { RoutePlan } from "../../types.js";
import { createPublicClient, createWalletClient, http } from "viem";

export interface BridgeExecutionResult {
  kind: string;
  status: "mocked" | "submitted" | "failed" | "bridge_pending";
  txHash?: string;
  attestationId?: string;
  details: Record<string, unknown>;
  reason?: string;
}

function mapChainKey(chainKey: string): string {
  switch (chainKey.toUpperCase()) {
    case "ARC": return "Arc_Testnet";
    case "BASE_SEPOLIA": return "Base_Sepolia";
    case "ETHEREUM_SEPOLIA": return "Ethereum_Sepolia";
    default: throw new Error(`Unsupported BridgeKit chain: ${chainKey}`);
  }
}

function mapChainDefinition(chainKey: string, bridgeKitImport: any): unknown {
  switch (chainKey.toUpperCase()) {
    case "ARC": return bridgeKitImport.ArcTestnet;
    case "BASE_SEPOLIA": return bridgeKitImport.BaseSepolia;
    case "ETHEREUM_SEPOLIA": return bridgeKitImport.EthereumSepolia;
    default: throw new Error(`Unsupported BridgeKit chain: ${chainKey}`);
  }
}

function getDestinationRecipient(plan: RoutePlan, fallbackAddress?: string): string | undefined {
  if (isBridgeOnlyProtocol(plan.protocol) && plan.recipient) return plan.recipient;
  if (plan.destinationChain === "BASE_SEPOLIA") return env.baseRouterAddress || fallbackAddress;
  if (plan.destinationChain === "ARC") return env.arcRouterAddress || fallbackAddress;
  if (plan.destinationChain === "ETHEREUM_SEPOLIA") return env.ethereumRouterAddress || fallbackAddress;
  return fallbackAddress;
}

function isBridgeOnlyProtocol(protocol: string): boolean {
  return protocol.endsWith("_USDC_TRANSFER");
}

function getTransferSpeed(): "FAST" | "SLOW" {
  return env.cctpMode.toLowerCase() === "fast" ? "FAST" : "SLOW";
}

export class CircleBridgeKitService {
  async bridge(plan: RoutePlan): Promise<BridgeExecutionResult> {
    if (plan.routeKind === "LOCAL") {
      return { kind: "LOCAL", status: "mocked", details: { message: "No bridge required." } };
    }

    if (env.demoMode) {
      return {
        kind: plan.routeKind,
        status: "mocked",
        txHash: `0xmock_${Date.now().toString(16)}`,
        details: { plan, quotedUserPaysUsd: plan.feeQuote?.userPaysUsd, quotedBridgeFeeUsd: plan.feeQuote?.bridgeFeeUsd, note: "DEMO_MODE enabled. Replace with BridgeKit/Gateway/CCTP execution." }
      };
    }

    if (!env.operatorPrivateKey) {
      return { kind: plan.routeKind, status: "failed", reason: "OPERATOR_PRIVATE_KEY not set.", details: { error: "OPERATOR_PRIVATE_KEY not set." } };
    }

    const bridgeKitImport = await optionalImport<any>("@circle-fin/bridge-kit");
    if (!bridgeKitImport) {
      return { kind: plan.routeKind, status: "failed", details: { error: "@circle-fin/bridge-kit is not installed." } };
    }

    const viemAdapterImport = await optionalImport<any>("@circle-fin/adapter-viem-v2");
    if (!viemAdapterImport) {
      return { kind: plan.routeKind, status: "failed", details: { error: "@circle-fin/adapter-viem-v2 is not installed." } };
    }

    try {
      const { BridgeKit } = bridgeKitImport;
      const { createViemAdapterFromPrivateKey } = viemAdapterImport;

      const srcChain = findChainByKey(plan.sourceChain);
      const dstChain = findChainByKey(plan.destinationChain);
      const srcRpc = process.env[srcChain.rpcEnv] ?? srcChain.rpcUrl;
      const dstRpc = process.env[dstChain.rpcEnv] ?? dstChain.rpcUrl;
      const rpcByChainId: Record<number, string> = {
        [srcChain.chainId]: srcRpc,
        [dstChain.chainId]: dstRpc,
      };
      const supportedChains = [
        mapChainDefinition(plan.sourceChain, bridgeKitImport),
        mapChainDefinition(plan.destinationChain, bridgeKitImport)
      ].filter(Boolean);

      const adapter = createViemAdapterFromPrivateKey({
        privateKey: env.operatorPrivateKey as `0x${string}`,
        capabilities: {
          addressContext: "user-controlled",
          supportedChains,
        },
        getPublicClient: ({ chain }: any) => {
          const rpc = rpcByChainId[chain.id];
          if (!rpc) throw new Error(`No RPC configured for BridgeKit chainId=${chain.id}`);
          return createPublicClient({ chain, transport: http(rpc) });
        },
        getWalletClient: ({ chain, account }: any) => {
          const rpc = rpcByChainId[chain.id];
          if (!rpc) throw new Error(`No RPC configured for BridgeKit chainId=${chain.id}`);
          return createWalletClient({ account, chain, transport: http(rpc) });
        },
      });
      const kit = new BridgeKit();
      const operatorAddress = await adapter.getAddress(mapChainDefinition(plan.sourceChain, bridgeKitImport));
      const recipientAddress = getDestinationRecipient(plan, operatorAddress);

      console.log(`[BridgeKit] Bridging ${plan.amount} USDC from ${plan.sourceChain} to ${plan.destinationChain}...`);
      
      const transfer = await kit.bridge({
        from: { adapter, chain: mapChainKey(plan.sourceChain) },
        to: { adapter, chain: mapChainKey(plan.destinationChain), recipientAddress },
        amount: plan.amount,
        token: "USDC",
        config: { transferSpeed: getTransferSpeed() },
      });

      console.log("[BridgeKit] Transfer completed:", transfer);

      return {
        kind: plan.routeKind,
        status: "submitted",
        txHash: transfer.steps?.find((step: any) => step.name === "mint" || step.name === "Mint")?.txHash,
        details: { message: "BridgeKit executed successfully.", recipientAddress, transfer }
      };
    } catch (err: any) {
      console.error("[BridgeKit] Error executing bridge:", err);
      return { 
        kind: plan.routeKind, 
        status: "failed", 
        reason: err.message || String(err),
        details: { error: err.message || String(err) } 
      };
    }
  }
}
