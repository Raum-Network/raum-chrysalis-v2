export type VmType = "evm" | "svm" | "soroban" | "xrpl";
export type RouteKind = "GATEWAY" | "BRIDGEKIT" | "CCTP_V2" | "LOCAL" | "MOCK" | "AXELAR_ITS";
export type IntentStatus = "created" | "quoted" | "planned" | "bridging" | "executing" | "finalizing" | "succeeded" | "failed" | "needs_approval";
export type OptimizationGoal = "balanced" | "lowest_cost" | "fastest" | "safest";
export type FeeConfidence = "low" | "medium" | "high";
 
export interface CreateIntentInput {
  sourceChain: string;
  destinationChain: string;
  asset: "USDC" | "EURC" | "XRP";
  amount: string;
  protocol: string;
  action: string;
  autonomous?: boolean;
  slippageBps?: number;
  recipient?: string;
  clientIntentId?: string;
  preferredRoute?: RouteKind;
  optimizationGoal?: OptimizationGoal;
  maxTotalFeeUsd?: string;
  preflightOnly?: boolean;
  approved?: boolean;
  quoteOnly?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FeeLineItem {
  key: string;
  label: string;
  chargedBy: "source_chain" | "destination_chain" | "circle" | "protocol" | "paymaster" | "application";
  payer: "user" | "developer" | "paymaster" | "not_applicable";
  amount: string;
  currency: string;
  amountUsd: string;
  isEstimate: boolean;
  notes?: string[];
}

export interface FeeQuote {
  quoteId: string;
  generatedAt: string;
  expiresAt: string;
  quoteCurrency: "USDC";
  confidence: FeeConfidence;
  routeKind: RouteKind;
  circleProduct: string;
  sourceChain: string;
  destinationChain: string;
  protocol: string;
  action: string;
  amountIn: string;
  asset: string;
  estimatedTimeSeconds: number;
  circleFeeBps: number;
  protocolFeeBps: number;
  slippageBps: number;
  sourceGasUsd: string;
  destinationGasUsd: string;
  arcGasUsd: string;
  sourceGasAmount: string;
  sourceGasToken: string;
  destinationGasAmount: string;
  destinationGasToken: string;
  networkGasUsd: string;
  bridgeFeeUsd: string;
  protocolFeeUsd: string;
  slippageUsd: string;
  paymasterSponsoredUsd: string;
  paymasterSurchargeUsd: string;
  userPaysUsd: string;
  sourceDepositRequiredUsd: string;
  totalEstimatedCostUsd: string;
  estimatedAmountToProtocol: string;
  minimumReceived: string;
  outputTokenSymbol: string;
  receiptTokenSymbol?: string;
  estimatedOutputAmount: string;
  minimumOutputAmount: string;
  feeLines: FeeLineItem[];
  assumptions: string[];
  warnings: string[];
}

export interface RouteAlternative {
  routeKind: RouteKind;
  eligible: boolean;
  score: number;
  estimatedTimeSeconds: number;
  feeQuote?: FeeQuote;
  reason: string;
  rejectionReasons: string[];
}

export interface IntentDecision {
  selectedRoute: RouteKind;
  selectedProtocol: string;
  selectedAction: string;
  optimizationGoal: OptimizationGoal;
  score: number;
  reason: string;
  approvalRequired: boolean;
  alternativesConsidered: Array<{
    routeKind: RouteKind;
    eligible: boolean;
    score: number;
    userPaysUsd?: string;
    totalEstimatedCostUsd?: string;
    estimatedTimeSeconds: number;
    reason: string;
    rejectionReasons: string[];
  }>;
}

export interface RoutePlan {
  routeKind: RouteKind;
  sourceChain: string;
  destinationChain: string;
  protocol: string;
  action: string;
  amount: string;
  executionAmount?: string;
  asset: string;
  /** User's wallet address — receives output tokens and NFT receipt */
  recipient?: string;
  requiresHumanApproval: boolean;
  rationale: string[];
  feeQuote?: FeeQuote;
  alternatives: RouteAlternative[];
  intentDecision?: IntentDecision;
  steps: Array<{ label: string; tool: string; status: "pending" | "mocked" | "ready" }>;
}

export interface NftReceipt {
  tokenId?: string;
  mintTxHash?: string;
  contractAddress?: string;
  network: "ARC";
  skipped?: boolean;
  reason?: string;
  feeLines?: FeeLineItem[];
  actualFeeUsd?: string;
}

export interface IntentReceipt {
  id: string;
  input: CreateIntentInput;
  status: IntentStatus;
  plan?: RoutePlan;
  bridgeReceipt?: Record<string, unknown>;
  protocolReceipt?: Record<string, unknown>;
  nftReceipt?: NftReceipt;
  traceRegistry?: Record<string, unknown>;
  actualFeeLines?: FeeLineItem[];
  actualFeeUsd?: string;
  aiNarration?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
