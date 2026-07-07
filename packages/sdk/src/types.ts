export type SupportedChain = "ARC" | "BASE_SEPOLIA" | "ETHEREUM_SEPOLIA" | "SOLANA_DEVNET" | "STELLAR_TESTNET";
export type SupportedAsset = "USDC" | "EURC" | "XRP";
export type RouteKind = "GATEWAY" | "BRIDGEKIT" | "CCTP_V2" | "LOCAL" | "MOCK" | "AXELAR_ITS";
export type OptimizationGoal = "balanced" | "lowest_cost" | "fastest" | "safest";
export type PaymasterMode = "sponsored" | "user_usdc" | "native" | "none";

export interface CreateIntentRequest {
  sourceChain: SupportedChain;
  destinationChain: SupportedChain;
  asset: SupportedAsset;
  amount: string;
  protocol: string;
  action: string;
  autonomous?: boolean;
  approved?: boolean;
  quoteOnly?: boolean;
  preflightOnly?: boolean;
  slippageBps?: number;
  recipient?: string;
  clientIntentId?: string;
  preferredRoute?: RouteKind;
  optimizationGoal?: OptimizationGoal;
  paymasterMode?: PaymasterMode;
  maxTotalFeeUsd?: string;
  metadata?: Record<string, unknown>;
}

export interface FeeLineItem {
  key: string;
  label: string;
  chargedBy: string;
  payer: string;
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
  confidence: "low" | "medium" | "high";
  routeKind: RouteKind;
  circleProduct: string;
  sourceChain: string;
  destinationChain: string;
  protocol: string;
  action: string;
  amountIn: string;
  asset: SupportedAsset | string;
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

export interface IntentResponse {
  id: string;
  status: string;
  input?: CreateIntentRequest;
  plan?: Record<string, unknown> & {
    feeQuote?: FeeQuote;
    alternatives?: RouteAlternative[];
    steps?: Array<{ label: string; tool: string; status: string }>;
  };
  bridgeReceipt?: Record<string, unknown>;
  protocolReceipt?: Record<string, unknown>;
  nftReceipt?: {
    tokenId?: string;
    mintTxHash?: string;
    contractAddress?: string;
    network?: string;
    skipped?: boolean;
    reason?: string;
    feeLines?: FeeLineItem[];
    actualFeeUsd?: string;
  };
  actualFeeLines?: FeeLineItem[];
  actualFeeUsd?: string;
  aiNarration?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OnChainTransactionStatus {
  label: string;
  hash: string;
  chain: string;
  status: {
    found: boolean;
    confirmed: boolean;
    finalized: boolean;
    blockNumber?: string;
    ledger?: number;
    status?: string;
    error?: unknown;
  };
}

export interface TransactionResponse extends IntentResponse {
  onChain?: {
    checkedAt: string;
    transactions: OnChainTransactionStatus[];
  };
}

export interface TransactionsResponse {
  source: string;
  count: number;
  transactions: TransactionResponse[];
}

export interface QuoteResponse {
  selected?: FeeQuote;
  alternatives: RouteAlternative[];
  plan: Record<string, unknown> & { feeQuote?: FeeQuote; alternatives?: RouteAlternative[] };
}

export interface GatewayPrepareResponse {
  gatewayWallet: `0x${string}`;
  sourceUsdc: `0x${string}`;
  depositor: `0x${string}`;
  mintRecipient: `0x${string}`;
  amount: string;
  maxFee: string;
  depositAmount: string;
  burnIntent: Record<string, unknown>;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  estimate: Record<string, unknown>;
}

export interface GatewayBalanceResponse {
  owner: string;
  token?: string;
  balances: Array<{
    domain?: number;
    chain?: string;
    depositor?: string;
    asset?: string;
    balance?: string;
    amount?: string;
    pendingBatch?: string;
  }>;
  error?: string;
}

export interface ChainInfo {
  key: string;
  name: string;
  vm: string;
  explorer?: string;
  hasGateway: boolean;
  hasCctp: boolean;
  hasPaymaster: boolean;
  supportsNanopayments: boolean;
}

export interface ProtocolInfo {
  key: string;
  name: string;
  type: string;
  category: string;
  actions: string[];
  circleService?: string;
}

export interface AppConfig {
  chains: ChainInfo[];
  protocolsByChain: Record<string, ProtocolInfo[]>;
  circleServicesByChain: Record<string, ProtocolInfo[]>;
  routes: RouteKind[];
  optimizationGoals: OptimizationGoal[];
  paymasterModes: PaymasterMode[];
  operatorAddress?: string;
  solanaOperatorAddress?: string;
  stellarOperatorAddress?: string;
  nanopaymentFeeReceiver?: string;
  nanopaymentFeeReceiverSource?: string;
  x402AcceptedNetworks?: string[];
}
