const GATEWAY_FORWARDING_SERVICE_FEE_USDC = 0.20;
const GATEWAY_FEE_BUFFER_MULTIPLIER = 1.6;
const GATEWAY_MAX_FEE_SAFETY_BUFFER_USDC = 0.01;

export function gatewayChainGasFeeUsdc(chainKey: string): number {
  const normalized = chainKey.toUpperCase();
  if (normalized.includes("BASE")) return 0.01;
  if (normalized.includes("ARBITRUM")) return 0.01;
  if (normalized.includes("OPTIMISM") || normalized.includes("OP")) return 0.0015;
  if (normalized.includes("POLYGON")) return 0.0015;
  if (normalized.includes("SEI")) return 0.001;
  if (normalized.includes("SOLANA")) return 0.15;
  if (normalized.includes("AVALANCHE")) return 0.02;
  if (normalized.includes("ETHEREUM") || normalized.includes("ETH")) return 1.00;
  if (normalized.includes("ARC")) return 0.01;
  return 0.01;
}

export function estimateGatewayMaxFeeUsdc(input: {
  amountUsdc: number;
  sourceChain: string;
  destinationChain: string;
}): number {
  const srcGasFee = gatewayChainGasFeeUsdc(input.sourceChain);
  const dstGasFee = gatewayChainGasFeeUsdc(input.destinationChain);
  const forwardingFee = GATEWAY_FORWARDING_SERVICE_FEE_USDC + dstGasFee;
  const transferFee = input.amountUsdc * 0.00005;
  return (srcGasFee + forwardingFee + transferFee) * GATEWAY_FEE_BUFFER_MULTIPLIER + GATEWAY_MAX_FEE_SAFETY_BUFFER_USDC;
}

export function addGatewayMaxFeeSafetyBuffer(maxFeeMinorUnits: bigint): bigint {
  return maxFeeMinorUnits + BigInt(Math.round(GATEWAY_MAX_FEE_SAFETY_BUFFER_USDC * 1_000_000));
}
