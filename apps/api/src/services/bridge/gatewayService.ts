import {
  createWalletClient, createPublicClient, http, parseAbi,
  type Hex, keccak256, pad, encodePacked
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainConfig, env, findChainByKey } from "../../config/index.js";
import { CreateIntentInput, RoutePlan } from "../../types.js";
import { addGatewayMaxFeeSafetyBuffer, estimateGatewayMaxFeeUsdc } from "../fees/gatewayFee.js";

/**
 * Circle Gateway bridge service — Unified USDC cross-chain transfer.
 *
 * Flow:
 *   1. Transfer USDC into the GatewayWallet contract on source chain
 *   2. Sign a BurnIntent via EIP-712 (domain: name="GatewayWallet", version="1" — no chainId!)
 *   3. POST to Gateway API with maxFee=0 first; if rejected for "Insufficient max fee",
 *      parse the required fee from the error, re-sign with that fee (+10% buffer), retry
 *   4. Forwarder auto-handles attestation + minting on destination
 *
 * EIP-712 domain confirmed on-chain: EIP712Domain(string name,string version) only.
 * BurnIntent/TransferSpec type hashes confirmed from contract bytecode.
 */

const GATEWAY_API = env.circleGatewayApiUrl || "https://gateway-api-testnet.circle.com";

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
]);

const gatewayWalletAbi = parseAbi([
  "function deposit(address token, uint256 value) external",
]);

const padAddr = (addr: string): Hex => pad(addr as Hex, { size: 32 });

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

const gatewayTransferSpecTypes = [
  { name: "version",              type: "uint32"  },
  { name: "sourceDomain",         type: "uint32"  },
  { name: "destinationDomain",    type: "uint32"  },
  { name: "sourceContract",       type: "bytes32" },
  { name: "destinationContract",  type: "bytes32" },
  { name: "sourceToken",          type: "bytes32" },
  { name: "destinationToken",     type: "bytes32" },
  { name: "sourceDepositor",      type: "bytes32" },
  { name: "destinationRecipient", type: "bytes32" },
  { name: "sourceSigner",         type: "bytes32" },
  { name: "destinationCaller",    type: "bytes32" },
  { name: "value",                type: "uint256" },
  { name: "salt",                 type: "bytes32" },
  { name: "hookData",             type: "bytes"   },
] as const;

const gatewayBurnIntentTypes = [
  { name: "maxBlockHeight", type: "uint256"      },
  { name: "maxFee",         type: "uint256"      },
  { name: "spec",           type: "TransferSpec" },
] as const;

export class GatewayService {
  async prepareUserGatewayTransfer(input: CreateIntentInput): Promise<Record<string, unknown>> {
    if (!input.recipient) throw new Error("recipient/user wallet is required for Gateway signing.");

    const srcChain = findChainByKey(input.sourceChain);
    const dstChain = findChainByKey(input.destinationChain);
    const srcGatewayWallet = srcChain.circle?.gateway?.wallet as string | undefined;
    const dstGatewayMinter = dstChain.circle?.gateway?.minter as string | undefined;
    if (!srcGatewayWallet) throw new Error(`Gateway Wallet not configured for ${input.sourceChain}.`);
    if (!dstGatewayMinter) throw new Error(`Gateway Minter not configured for ${input.destinationChain}.`);

    const sourceUsdc = srcChain.tokens?.USDC?.address as Hex;
    const destUsdc = dstChain.tokens?.USDC?.address as Hex;
    const amount = BigInt(Math.floor(Number(input.amount) * 1_000_000));
    const depositor = input.recipient as Hex;
    const dstRouter = input.destinationChain === "BASE_SEPOLIA" ? env.baseRouterAddress
      : input.destinationChain === "ARC" ? env.arcRouterAddress
      : input.destinationChain === "ETHEREUM_SEPOLIA" ? env.ethereumRouterAddress
      : "";
    const bridgeOnly = isBridgeOnlyProtocol(input.protocol);
    const recipientAddr = (bridgeOnly ? input.recipient : dstRouter || input.recipient) as Hex;
    const salt = keccak256(encodePacked(
      ["address", "uint256", "uint256"],
      [depositor, amount, BigInt(Date.now())]
    ));

    const spec = {
      version:              1,
      sourceDomain:         srcChain.cctpDomain as number,
      destinationDomain:    dstChain.cctpDomain as number,
      sourceContract:       padAddr(srcGatewayWallet),
      destinationContract:  padAddr(dstGatewayMinter),
      sourceToken:          padAddr(sourceUsdc),
      destinationToken:     padAddr(destUsdc),
      sourceDepositor:      padAddr(depositor),
      destinationRecipient: padAddr(recipientAddr),
      sourceSigner:         padAddr(depositor),
      destinationCaller:    ("0x" + "00".repeat(32)) as Hex,
      value:                amount,
      salt:                 salt as Hex,
      hookData:             "0x" as Hex,
    };

    const estimateBody = [{ spec: this.serializeSpec(spec) }];
    const estimateRes = await fetch(`${GATEWAY_API}/v1/estimate?enableForwarder=true`, {
      method: "POST",
      headers: { "authorization": `Bearer ${env.circleApiKey}`, "content-type": "application/json" },
      body: JSON.stringify(estimateBody),
    });
    const estimateText = await estimateRes.text();
    let estimateData: any;
    try { estimateData = JSON.parse(estimateText); } catch { estimateData = { raw: estimateText }; }
    if (!estimateRes.ok) throw new Error(`Gateway estimate error ${estimateRes.status}: ${estimateText}`);

    const estimatedBurnIntent = estimateData.body?.[0]?.burnIntent ?? estimateData[0]?.burnIntent;
    if (!estimatedBurnIntent?.maxFee || !estimatedBurnIntent?.maxBlockHeight) {
      throw new Error(`Gateway estimate response missing burnIntent.maxFee/maxBlockHeight: ${estimateText}`);
    }

    const estimatedMaxFee = BigInt(estimatedBurnIntent.maxFee);
    const quoteMaxFee = BigInt(Math.ceil(estimateGatewayMaxFeeUsdc({
      amountUsdc: Number(input.amount),
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain
    }) * 1_000_000));
    const maxFee = maxBigInt(addGatewayMaxFeeSafetyBuffer(estimatedMaxFee), quoteMaxFee);
    // ARC uses USDC as native gas — each deposit tx consumes ~0.05 USDC (~50000 units).
    // Add a gas buffer so the net deposit still covers value + maxFee after gas deduction.
    const GAS_BUFFER = srcChain.key === "ARC" ? 50_000n : 0n;
    const depositAmount = amount + maxFee + GAS_BUFFER;
    const burnIntent = {
      maxBlockHeight: BigInt(estimatedBurnIntent.maxBlockHeight),
      maxFee,
      spec
    };

    return {
      gatewayWallet: srcGatewayWallet,
      sourceUsdc,
      depositor,
      mintRecipient: recipientAddr,
      amount: amount.toString(),
      maxFee: maxFee.toString(),
      depositAmount: depositAmount.toString(),
      burnIntent: this.serializeBurnIntent(burnIntent),
      typedData: {
        domain: { name: "GatewayWallet", version: "1" },
        types: {
          TransferSpec: gatewayTransferSpecTypes,
          BurnIntent: gatewayBurnIntentTypes,
        },
        primaryType: "BurnIntent",
        message: this.serializeBurnIntent(burnIntent),
      },
      estimate: estimateData
    };
  }

  async executeGatewayMint(plan: RoutePlan, metadata?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (env.demoMode) {
      return { status: "mocked", gatewayTransferId: `gw_${Date.now().toString(36)}`, circleProduct: "Gateway" };
    }

    try {
      if (metadata?.gatewayBurnIntent && metadata?.gatewaySignature && metadata?.gatewayDepositor) {
        return this.submitUserSignedGatewayTransfer(plan, metadata);
      }

      return {
        status: "bridge_failed",
        reason: "Gateway route requires user Gateway deposit and user-signed BurnIntent. Re-quote and execute from the updated frontend."
      };

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[GatewayService] failed:", message);
      return { status: "bridge_failed", reason: message };
    }
  }

  async getUnifiedBalance(owner: string): Promise<Record<string, unknown>> {
    if (env.demoMode) {
      return { owner, balances: [
        { chain: "ARC",          asset: "USDC", amount: "100.00" },
        { chain: "BASE_SEPOLIA", asset: "USDC", amount: "20.00"  },
      ]};
    }
    try {
      const res = await fetch(`${GATEWAY_API}/v1/balances`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.circleApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          token: "USDC",
          sources: [{ depositor: owner }]
        })
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json() as any;
      const balances = (data.balances ?? []).map((balance: any) => {
        const chain = Object.values(chainConfig).find((candidate: any) => candidate.cctpDomain === balance.domain) as any;
        return {
          ...balance,
          chain: chain?.key,
          asset: data.token ?? balance.asset ?? balance.token,
          amount: balance.balance ?? balance.amount ?? "0"
        };
      });
      return { ...data, owner, balances };
    } catch (err) {
      return {
        owner,
        balances: [],
        error: `Balance query failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  private async submitUserSignedGatewayTransfer(plan: RoutePlan, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
    const burnIntent = metadata.gatewayBurnIntent as any;
    const signature = metadata.gatewaySignature as Hex;
    const depositor = metadata.gatewayDepositor as string;
    const depositTxHash = metadata.gatewayDepositTxHash as Hex | undefined;
    const valueUsdc = Number(burnIntent.spec.value) / 1e6;
    const expectedBalance = Number((BigInt(burnIntent.spec.value) + BigInt(burnIntent.maxFee))) / 1e6;

    console.log(`[Gateway] Waiting for user Gateway balance for depositor ${depositor}: expected ${expectedBalance} USDC (value ${valueUsdc})...`);
    const indexed = await this.waitForGatewayBalance(depositor, plan.sourceChain, expectedBalance, 3 * 60 * 1000);
    if (!indexed) {
      // If the deposit tx is confirmed on-chain but Circle indexed slightly less
      // (ARC uses USDC for gas, making exact balance matching brittle), fall back
      // by requiring at least the transfer value.
      const minBalance = await this.waitForGatewayBalance(depositor, plan.sourceChain, valueUsdc, 60_000);
      if (!minBalance) {
        return {
          status: "bridge_failed",
          depositTxHash,
          reason: `Gateway deposit not indexed for depositor ${depositor}. Required at least ${valueUsdc} USDC on ${plan.sourceChain}.`
        };
      }
      console.log(`[Gateway] Proceeding with available balance (${expectedBalance} expected, below required maxFee) — Gateway API will cap the fee.`);
    }

    const body = [{
      burnIntent: {
        maxBlockHeight: String(burnIntent.maxBlockHeight),
        maxFee: String(burnIntent.maxFee),
        spec: {
          ...burnIntent.spec,
          value: String(burnIntent.spec.value),
        }
      },
      signature,
    }];

    const res = await fetch(`${GATEWAY_API}/v1/transfer?enableForwarder=true`, {
      method: "POST",
      headers: { "authorization": `Bearer ${env.circleApiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let responseData: any;
    try { responseData = JSON.parse(text); } catch { responseData = { raw: text }; }
    if (!res.ok) {
      return { status: "bridge_failed", httpStatus: res.status, depositTxHash, reason: `Gateway API error ${res.status}: ${text}` };
    }

    const transferId = responseData.transferId || (Array.isArray(responseData) ? responseData[0]?.transferId : undefined);
    if (!transferId) {
      return { status: "bridge_failed", depositTxHash, reason: `No transferId returned in Circle Gateway response.` };
    }

    const gatewayStatus = await this.waitForTransferStatus(transferId, depositTxHash);
    if (gatewayStatus.status === "bridge_failed") return gatewayStatus;

    return {
      status: "submitted",
      depositTxHash,
      transferId,
      gatewayResponse: responseData,
      gatewayStatus: gatewayStatus.gatewayStatus,
      circleProduct: "Gateway",
      mintRecipient: metadata.gatewayMintRecipient,
      bridgeFeeUsdc: Number(BigInt(burnIntent.maxFee)) / 1e6,
      depositor
    };
  }

  private async waitForGatewayBalance(owner: string, chainKey: string, requiredBalance: number, maxWaitMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const balData = await this.getUnifiedBalance(owner);
      const balances = (balData as any).balances || [];
      const balanceObj = balances.find((b: any) =>
        (b.chain === chainKey || b.domain === findChainByKey(chainKey).cctpDomain) &&
        (b.asset === "USDC" || b.asset === "EURC" || b.token === "USDC")
      );
      const available = Number(balanceObj?.amount ?? balanceObj?.balance ?? 0);
      console.log(`[Gateway] Indexed user balance on ${chainKey}: ${available} USDC (required ${requiredBalance})`);
      if (available >= requiredBalance) return true;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return false;
  }

  private async waitForTransferStatus(transferId: string, depositTxHash?: Hex): Promise<Record<string, unknown>> {
    const started = Date.now();
    const maxWaitMs = 30 * 60 * 1000;
    let finalTransferStatus: any;
    while (Date.now() - started < maxWaitMs) {
      const statusRes = await fetch(`${GATEWAY_API}/v1/transfer/${transferId}`, {
        headers: { "authorization": `Bearer ${env.circleApiKey}` }
      });
      if (statusRes.ok) {
        const statusData = await statusRes.json() as any;
        finalTransferStatus = statusData;
        const status = statusData.status;
        console.log(`[Gateway] Transfer status: ${status} (elapsed: ${Math.round((Date.now() - started) / 1000)}s)`, statusData.forwardingDetails ?? "");
        if (status === "confirmed" || status === "finalized" || status === "complete") {
          return { status: "submitted", gatewayStatus: statusData };
        }
        if (status === "failed" || status === "expired") {
          return { status: "bridge_failed", depositTxHash, transferId, gatewayStatus: statusData, reason: `Gateway transfer status failed: ${status}. ${statusData.forwardingDetails?.failureReason ?? ""}`.trim() };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return { status: "bridge_failed", depositTxHash, transferId, gatewayStatus: finalTransferStatus, reason: `Gateway transfer not confirmed/finalized within ${maxWaitMs / 1000}s.` };
  }

  private serializeSpec(spec: any) {
    return {
      version:              spec.version,
      sourceDomain:         spec.sourceDomain,
      destinationDomain:    spec.destinationDomain,
      sourceContract:       spec.sourceContract,
      destinationContract:  spec.destinationContract,
      sourceToken:          spec.sourceToken,
      destinationToken:     spec.destinationToken,
      sourceDepositor:      spec.sourceDepositor,
      destinationRecipient: spec.destinationRecipient,
      sourceSigner:         spec.sourceSigner,
      destinationCaller:    spec.destinationCaller,
      value:                spec.value.toString(),
      salt:                 spec.salt,
      hookData:             spec.hookData,
    };
  }

  private serializeBurnIntent(burnIntent: any) {
    return {
      maxBlockHeight: burnIntent.maxBlockHeight.toString(),
      maxFee: burnIntent.maxFee.toString(),
      spec: this.serializeSpec(burnIntent.spec)
    };
  }
}

function isBridgeOnlyProtocol(protocol: string): boolean {
  return protocol.endsWith("_USDC_TRANSFER");
}
