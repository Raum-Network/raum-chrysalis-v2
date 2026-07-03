import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, findChainByKey } from "../../config/index.js";
import type { IntentReceipt, NftReceipt } from "../../types.js";
import { parseUnitsDecimal } from "../../utils/amounts.js";

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
const ZERO_SELECTOR = "0x00000000" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

const REGISTRY_ABI = parseAbi([
  "function recorders(address) external view returns (bool)",
  "function intents(bytes32) external view returns (address userAddress, bytes32 userRef, bytes32 sourceChainKey, bytes32 destinationChainKey, bytes32 protocolKey, bytes32 actionKey, bytes32 assetKey, uint256 amount, uint64 createdAt, uint64 updatedAt, uint16 stepCount, uint8 status)",
  "function registerIntent(bytes32 intentId, address userAddress, bytes32 userRef, bytes32 sourceChainKey, bytes32 destinationChainKey, bytes32 protocolKey, bytes32 actionKey, bytes32 assetKey, uint256 amount) external",
  "function recordStep(bytes32 intentId, bytes32 stageKey, bytes32 chainKey, bytes32 txHashRef, address targetContract, bytes4 functionSelector, bytes32 protocolKey, uint256 amount) external returns (uint16 stepIndex)",
  "function recordExternalStep(bytes32 intentId, bytes32 stageKey, bytes32 chainKey, string externalTxHash, address targetContract, bytes4 functionSelector, bytes32 protocolKey, uint256 amount) external returns (uint16 stepIndex)",
  "function updateIntentStatus(bytes32 intentId, uint8 status) external"
]);

type TraceContext = {
  registryAddress: Hex;
  registryIntentId: Hex;
  recorder: Hex;
  publicClient: any;
  walletClient: any;
};

export type TraceWrite = {
  kind: "register" | "step" | "status" | "skipped" | "error";
  registryAddress?: string;
  registryIntentId?: string;
  recorder?: string;
  txHash?: string;
  blockNumber?: string;
  stage?: string;
  chain?: string;
  externalTxHash?: string;
  status?: "registered" | "completed" | "failed";
  reason?: string;
  error?: string;
};

type StepInput = {
  stage: string;
  chain: string;
  txHash?: string;
  targetContract?: string;
  functionSelector?: Hex;
  protocol?: string;
  amount?: bigint;
  forceExternal?: boolean;
  allowZeroTxRef?: boolean;
};

export type TraceRegistryReceipt = {
  registryAddress?: string;
  registryIntentId?: string;
  recorder?: string;
  updatedAt?: string;
  writes?: TraceWrite[];
  errors?: string[];
  skipped?: boolean;
  reason?: string;
};

export function mergeTraceRegistryReceipt(
  current: unknown,
  next: TraceWrite
): TraceRegistryReceipt {
  const existing = isTraceRegistryReceipt(current) ? current : {};
  const writes = [...(existing.writes ?? [])];
  const errors = [...(existing.errors ?? [])];

  if (next.kind === "error" && next.error) errors.push(next.error);
  if (next.kind !== "skipped" || !existing.skipped) writes.push(next);

  return {
    ...existing,
    registryAddress: next.registryAddress ?? existing.registryAddress,
    registryIntentId: next.registryIntentId ?? existing.registryIntentId,
    recorder: next.recorder ?? existing.recorder,
    updatedAt: new Date().toISOString(),
    writes: writes.slice(-100),
    errors: errors.slice(-25),
    skipped: next.kind === "skipped" ? true : existing.skipped,
    reason: next.reason ?? existing.reason
  };
}

export class IntentTraceRegistryService {
  private cachedContext: Omit<TraceContext, "registryIntentId"> | null | undefined;

  isConfigured(): boolean {
    return Boolean(env.intentTraceEnabled && env.intentTraceRegistryAddress);
  }

  async registerIntent(receipt: IntentReceipt): Promise<TraceWrite> {
    const context = await this.context(receipt);
    if (!context.ok) return context.write;

    const { registryIntentId, publicClient, walletClient, registryAddress } = context.value;
    const alreadyRegistered = await this.intentRegistered(context.value, registryIntentId);
    if (alreadyRegistered) {
      return this.baseWrite(context.value, {
        kind: "register",
        reason: "Intent already registered."
      });
    }

    const hash = await walletClient.writeContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "registerIntent",
      args: [
        registryIntentId,
        userAddressFor(receipt),
        userRefFor(receipt),
        keyToBytes32(receipt.input.sourceChain),
        keyToBytes32(receipt.input.destinationChain),
        keyToBytes32(receipt.input.protocol),
        keyToBytes32(receipt.input.action),
        keyToBytes32(receipt.input.asset),
        amountFor(receipt)
      ]
    });
    const tx = await publicClient.waitForTransactionReceipt({ hash });
    return this.baseWrite(context.value, {
      kind: "register",
      txHash: hash,
      blockNumber: tx.blockNumber.toString(),
      status: "registered"
    });
  }

  async recordSourceTransactions(receipt: IntentReceipt): Promise<TraceWrite[]> {
    const metadata = receipt.input.metadata ?? {};
    const amount = amountFor(receipt);
    const steps: StepInput[] = [
      {
        stage: "SOURCE_APPROVE",
        chain: receipt.input.sourceChain,
        txHash: stringValue(metadata.gatewayApproveTxHash),
        protocol: receipt.plan?.routeKind ?? "GATEWAY",
        amount
      },
      {
        stage: "SOURCE_DEPOSIT",
        chain: receipt.input.sourceChain,
        txHash: stringValue(metadata.gatewayDepositTxHash),
        protocol: receipt.plan?.routeKind ?? "GATEWAY",
        amount
      },
      {
        stage: "SOURCE_DEPOSIT",
        chain: receipt.input.sourceChain,
        txHash: stringValue(metadata.userDepositTxHash),
        protocol: `${receipt.input.asset}_TRANSFER`,
        amount
      }
    ];
    return this.recordSteps(receipt, dedupeSteps(steps));
  }

  async recordBridge(receipt: IntentReceipt, bridgeReceipt: Record<string, unknown>): Promise<TraceWrite[]> {
    const plan = receipt.plan;
    if (!plan) return [];

    const amount = amountFor(receipt);
    const protocol = String(bridgeReceipt.circleProduct ?? plan.routeKind);
    const steps: StepInput[] = [
      {
        stage: "BRIDGE_APPROVE",
        chain: plan.sourceChain,
        txHash: stringValue(bridgeReceipt.approveTxHash),
        targetContract: cctpTokenMessenger(plan.sourceChain),
        functionSelector: selector("approve(address,uint256)"),
        protocol,
        amount
      },
      {
        stage: "BRIDGE_BURN",
        chain: plan.sourceChain,
        txHash: stringValue(bridgeReceipt.burnTxHash),
        targetContract: cctpTokenMessenger(plan.sourceChain),
        functionSelector: selector("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"),
        protocol,
        amount
      },
      {
        stage: "BRIDGE_MINT",
        chain: plan.destinationChain,
        txHash: stringValue(bridgeReceipt.txHash),
        protocol,
        amount
      },
      {
        stage: "BRIDGE_MINT",
        chain: plan.destinationChain,
        txHash: stringValue(bridgeReceipt.mintTxHash),
        targetContract: cctpMessageTransmitter(plan.destinationChain),
        functionSelector: selector("receiveMessage(bytes,bytes)"),
        protocol,
        amount
      },
      {
        stage: "BRIDGE_SETUP",
        chain: plan.destinationChain,
        txHash: stringValue(bridgeReceipt.solanaSetupTxHash),
        protocol,
        amount,
        forceExternal: true
      },
      {
        stage: "BRIDGE_MINT",
        chain: plan.destinationChain,
        txHash: stringValue(bridgeReceipt.solanaTxHash),
        protocol,
        amount,
        forceExternal: true
      },
      {
        stage: "BRIDGE_MINT",
        chain: plan.destinationChain,
        txHash: stringValue(bridgeReceipt.stellarTxHash),
        protocol,
        amount,
        forceExternal: true
      }
    ];

    if (steps.every((step) => !step.txHash) && bridgeReceipt.transferId) {
      steps.push({
        stage: "BRIDGE_TRANSFER",
        chain: plan.destinationChain,
        txHash: stringValue(bridgeReceipt.transferId),
        protocol,
        amount,
        forceExternal: true
      });
    }

    steps.push(...bridgeKitTransferSteps(bridgeReceipt, plan, amount, protocol));

    return this.recordSteps(receipt, dedupeSteps(steps));
  }

  async recordProtocol(receipt: IntentReceipt, protocolReceipt: Record<string, unknown>): Promise<TraceWrite[]> {
    const plan = receipt.plan;
    if (!plan) return [];

    const amount = amountFor(receipt, plan.executionAmount ?? plan.amount);
    const steps: StepInput[] = [
      {
        stage: "PROTOCOL_CALL",
        chain: plan.destinationChain,
        txHash: stringValue(protocolReceipt.txHash),
        targetContract: routerAddressFor(plan.destinationChain),
        functionSelector: selector("executeWithRouterBalance(bytes32,bytes32,address,address,uint256,bytes)"),
        protocol: plan.protocol,
        amount
      },
      {
        stage: "PROTOCOL_CALL",
        chain: plan.destinationChain,
        txHash: stringValue(protocolReceipt.solanaTxHash),
        protocol: plan.protocol,
        amount,
        forceExternal: true
      },
      {
        stage: "PROTOCOL_CALL",
        chain: plan.destinationChain,
        txHash: stringValue(protocolReceipt.stellarTxHash),
        protocol: plan.protocol,
        amount,
        forceExternal: true
      },
      {
        stage: "PROTOCOL_RELAY",
        chain: plan.destinationChain,
        txHash: stringValue(protocolReceipt.stellarRelayTxHash),
        protocol: plan.protocol,
        amount,
        forceExternal: true
      }
    ];

    const isBridgeOnly = protocolReceipt.action === "transfer" || protocolReceipt.note === "Bridge-only transfer complete; no protocol adapter execution was required.";
    if (isBridgeOnly && steps.every((step) => !step.txHash)) {
      steps.push({
        stage: "PROTOCOL_SKIPPED",
        chain: plan.destinationChain,
        protocol: plan.protocol,
        amount,
        allowZeroTxRef: true
      });
    }

    return this.recordSteps(receipt, dedupeSteps(steps));
  }

  async recordReceiptMint(receipt: IntentReceipt, nftReceipt: NftReceipt): Promise<TraceWrite[]> {
    const amount = amountFor(receipt, receipt.plan?.executionAmount ?? receipt.input.amount);
    const step: StepInput = {
      stage: nftReceipt.mintTxHash ? "RECEIPT_MINT" : "RECEIPT_SKIPPED",
      chain: "ARC",
      txHash: nftReceipt.mintTxHash,
      targetContract: nftReceipt.contractAddress,
      functionSelector: selector("mintReceiptV2(address,string,string,string,string,string,string,string,string,string,string,string)"),
      protocol: "ARC_RECEIPT",
      amount,
      allowZeroTxRef: !nftReceipt.mintTxHash
    };
    return this.recordSteps(receipt, [step]);
  }

  async updateStatus(receipt: IntentReceipt, status: "completed" | "failed"): Promise<TraceWrite> {
    const context = await this.context(receipt);
    if (!context.ok) return context.write;

    const { publicClient, walletClient, registryAddress, registryIntentId } = context.value;
    const hash = await walletClient.writeContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "updateIntentStatus",
      args: [registryIntentId, status === "completed" ? 2 : 3]
    });
    const tx = await publicClient.waitForTransactionReceipt({ hash });
    return this.baseWrite(context.value, {
      kind: "status",
      txHash: hash,
      blockNumber: tx.blockNumber.toString(),
      status
    });
  }

  private async recordSteps(receipt: IntentReceipt, steps: StepInput[]): Promise<TraceWrite[]> {
    const usable = steps.filter((step) => step.txHash || step.allowZeroTxRef);
    if (usable.length === 0) return [];

    const context = await this.context(receipt);
    if (!context.ok) return [context.write];

    const writes: TraceWrite[] = [];
    for (const step of usable) {
      try {
        writes.push(await this.recordStep(context.value, step));
      } catch (err) {
        writes.push(this.baseWrite(context.value, {
          kind: "error",
          stage: step.stage,
          chain: step.chain,
          externalTxHash: step.txHash,
          error: err instanceof Error ? err.message : String(err)
        }));
      }
    }
    return writes;
  }

  private async recordStep(context: TraceContext, step: StepInput): Promise<TraceWrite> {
    const txHash = step.txHash?.trim();
    const targetContract = safeAddress(step.targetContract);
    const functionSelector = step.functionSelector ?? ZERO_SELECTOR;
    const protocolKey = keyToBytes32(step.protocol ?? "UNKNOWN");
    const amount = step.amount ?? 0n;

    let hash: Hex;
    if (txHash && (step.forceExternal || !isBytes32Hex(txHash))) {
      hash = await context.walletClient.writeContract({
        address: context.registryAddress,
        abi: REGISTRY_ABI,
        functionName: "recordExternalStep",
        args: [
          context.registryIntentId,
          keyToBytes32(step.stage),
          keyToBytes32(step.chain),
          txHash,
          targetContract,
          functionSelector,
          protocolKey,
          amount
        ]
      });
    } else {
      hash = await context.walletClient.writeContract({
        address: context.registryAddress,
        abi: REGISTRY_ABI,
        functionName: "recordStep",
        args: [
          context.registryIntentId,
          keyToBytes32(step.stage),
          keyToBytes32(step.chain),
          txHash && isBytes32Hex(txHash) ? txHash as Hex : ZERO_BYTES32,
          targetContract,
          functionSelector,
          protocolKey,
          amount
        ]
      });
    }

    const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
    return this.baseWrite(context, {
      kind: "step",
      stage: step.stage,
      chain: step.chain,
      externalTxHash: txHash,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString()
    });
  }

  private async context(receipt: IntentReceipt): Promise<{ ok: true; value: TraceContext } | { ok: false; write: TraceWrite }> {
    const base = await this.baseContext();
    const registryIntentId = intentIdFor(receipt);
    if (!base.ok) {
      return {
        ok: false,
        write: {
          ...base.write,
          registryIntentId
        }
      };
    }
    return { ok: true, value: { ...base.value, registryIntentId } };
  }

  private async baseContext(): Promise<
    | { ok: true; value: Omit<TraceContext, "registryIntentId"> }
    | { ok: false; write: TraceWrite }
  > {
    if (!env.intentTraceEnabled) {
      return { ok: false, write: { kind: "skipped", reason: "INTENT_TRACE_ENABLED=false." } };
    }

    const registryAddress = env.intentTraceRegistryAddress;
    if (!registryAddress || !isAddress(registryAddress)) {
      return { ok: false, write: { kind: "skipped", reason: "INTENT_TRACE_REGISTRY or INTENT_TRACE_REGISTRY_ADDRESS is not configured." } };
    }

    if (this.cachedContext) return { ok: true, value: this.cachedContext };

    const registryChain = findChainByKey(env.intentTraceRegistryChain);
    const rpcUrl = process.env[registryChain.rpcEnv] ?? registryChain.rpcUrl;
    const viemChain = {
      id: registryChain.chainId,
      name: registryChain.name,
      nativeCurrency: registryChain.nativeCurrency ?? { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } }
    };
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

    const candidateKeys = uniqueStrings([
      env.intentTraceRecorderPrivateKey,
      env.operatorPrivateKey,
      process.env.DEPLOYER_PRIVATE_KEY ?? ""
    ]);

    for (const privateKey of candidateKeys) {
      try {
        const account = privateKeyToAccount(privateKey as Hex);
        const isRecorder = await publicClient.readContract({
          address: registryAddress as Hex,
          abi: REGISTRY_ABI,
          functionName: "recorders",
          args: [account.address]
        }) as boolean;
        if (!isRecorder) continue;

        this.cachedContext = {
          registryAddress: registryAddress as Hex,
          recorder: account.address,
          publicClient,
          walletClient: createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) })
        };
        return { ok: true, value: this.cachedContext };
      } catch (err) {
        console.warn("[IntentTraceRegistry] recorder candidate skipped:", err instanceof Error ? err.message : String(err));
      }
    }

    return {
      ok: false,
      write: {
        kind: "skipped",
        registryAddress,
        reason: "No configured private key is enabled as a recorder on IntentTraceRegistry."
      }
    };
  }

  private async intentRegistered(context: TraceContext, intentId: Hex): Promise<boolean> {
    const result = await context.publicClient.readContract({
      address: context.registryAddress,
      abi: REGISTRY_ABI,
      functionName: "intents",
      args: [intentId]
    }) as unknown as readonly unknown[];
    return Number(result[11] ?? 0) !== 0;
  }

  private baseWrite(context: TraceContext, write: TraceWrite): TraceWrite {
    return {
      registryAddress: context.registryAddress,
      registryIntentId: context.registryIntentId,
      recorder: context.recorder,
      ...write
    };
  }
}

export const intentTraceRegistry = new IntentTraceRegistryService();

function isTraceRegistryReceipt(value: unknown): value is TraceRegistryReceipt {
  return Boolean(value && typeof value === "object");
}

function intentIdFor(receipt: IntentReceipt): Hex {
  return keccak256(toBytes(receipt.id));
}

function userAddressFor(receipt: IntentReceipt): Hex {
  for (const candidate of userRefCandidates(receipt)) {
    if (isAddress(candidate)) return candidate as Hex;
  }
  return ZERO_ADDRESS;
}

function userRefFor(receipt: IntentReceipt): Hex {
  const ref = userRefCandidates(receipt).find((candidate) => candidate.length > 0);
  return ref ? keccak256(toBytes(ref)) : ZERO_BYTES32;
}

function userRefCandidates(receipt: IntentReceipt): string[] {
  const metadata = receipt.input.metadata ?? {};
  return [
    stringValue(metadata.sourceWalletAddress),
    stringValue(metadata.evmReceiptWalletAddress),
    stringValue(metadata.gatewayDepositor),
    stringValue(metadata.evmAddress),
    stringValue(metadata.solanaAddress),
    stringValue(metadata.stellarAddress),
    receipt.input.recipient,
    receipt.input.clientIntentId
  ].filter((value): value is string => Boolean(value));
}

function amountFor(receipt: IntentReceipt, amount = receipt.input.amount): bigint {
  const sourceChain = findChainByKey(receipt.input.sourceChain);
  const decimals = Number(sourceChain.tokens?.[receipt.input.asset]?.decimals ?? 6);
  return parseUnitsDecimal(amount, decimals);
}

function keyToBytes32(value: string): Hex {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_:-]/g, "_");
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length > 32) return keccak256(toBytes(normalized));
  return `0x${bytes.toString("hex").padEnd(64, "0")}` as Hex;
}

function selector(signature: string): Hex {
  return keccak256(toBytes(signature)).slice(0, 10) as Hex;
}

function isBytes32Hex(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function safeAddress(value: unknown): Hex {
  return typeof value === "string" && isAddress(value) ? value as Hex : ZERO_ADDRESS;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function dedupeSteps(steps: StepInput[]): StepInput[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    if (!step.txHash && !step.allowZeroTxRef) return false;
    const key = `${step.stage}:${step.chain}:${step.txHash ?? "zero"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bridgeKitTransferSteps(
  bridgeReceipt: Record<string, unknown>,
  plan: { sourceChain: string; destinationChain: string },
  amount: bigint,
  protocol: string
): StepInput[] {
  const details = objectValue(bridgeReceipt.details);
  const transfer = objectValue(details?.transfer);
  const rawSteps = Array.isArray(transfer?.steps) ? transfer.steps : [];

  return rawSteps.flatMap((raw): StepInput[] => {
    const item = objectValue(raw);
    if (!item) return [];
    const txHash = stringValue(item.txHash ?? item.transactionHash ?? item.hash);
    if (!txHash) return [];

    const name = String(item.name ?? item.type ?? item.action ?? "").toLowerCase();
    const stage = bridgeKitStage(name);
    const chain = bridgeKitChain(item.chain ?? item.network ?? item.chainKey, stage, plan);
    return [{
      stage,
      chain,
      txHash,
      protocol,
      amount
    }];
  });
}

function bridgeKitStage(name: string): string {
  if (name.includes("approve")) return "BRIDGE_APPROVE";
  if (name.includes("burn") || name.includes("deposit") || name.includes("lock")) return "BRIDGE_BURN";
  if (name.includes("mint") || name.includes("receive") || name.includes("claim")) return "BRIDGE_MINT";
  return "BRIDGE_TRANSFER";
}

function bridgeKitChain(
  rawChain: unknown,
  stage: string,
  plan: { sourceChain: string; destinationChain: string }
): string {
  const value = typeof rawChain === "string" ? rawChain.toUpperCase() : "";
  if (value.includes("ARC")) return "ARC";
  if (value.includes("BASE")) return "BASE_SEPOLIA";
  if (value.includes("ETHEREUM") || value.includes("SEPOLIA")) return "ETHEREUM_SEPOLIA";
  return stage === "BRIDGE_MINT" ? plan.destinationChain : plan.sourceChain;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function routerAddressFor(chainKey: string): string | undefined {
  if (chainKey === "ARC") return env.arcRouterAddress;
  if (chainKey === "BASE_SEPOLIA") return env.baseRouterAddress;
  if (chainKey === "ETHEREUM_SEPOLIA") return env.ethereumRouterAddress;
  return undefined;
}

function cctpTokenMessenger(chainKey: string): string | undefined {
  try {
    return findChainByKey(chainKey).circle?.cctp?.tokenMessengerV2;
  } catch {
    return undefined;
  }
}

function cctpMessageTransmitter(chainKey: string): string | undefined {
  try {
    return findChainByKey(chainKey).circle?.cctp?.messageTransmitterV2;
  } catch {
    return undefined;
  }
}
