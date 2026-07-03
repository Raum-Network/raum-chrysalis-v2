import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Load .env from repo root (4 levels up: config/ → src/ → api/ → apps/ → root)
dotenv.config({ path: resolve(here, "../../../../.env") });

function loadRepoJson<T>(relativeFile: string): T {
  return JSON.parse(readFileSync(resolve(here, "../../../../configs", relativeFile), "utf8")) as T;
}

export const env = {
  apiPort: Number(process.env.API_PORT ?? 8787),
  demoMode: false,
  agentDryRun: process.env.AGENT_DRY_RUN !== "false",
  // When true (default), fee estimation always tries live testnet data (RPC gas, Circle Iris,
  // token prices) even while execution stays mocked under DEMO_MODE. Set LIVE_FEES=false to
  // force the static fee-model.json / .env fallbacks only.
  liveFees: process.env.LIVE_FEES !== "false",
  feeQuoteTtlSeconds: Number(process.env.FEE_QUOTE_TTL_SECONDS ?? 120),
  circleApiKey: process.env.CIRCLE_API_KEY ?? "",
  circleGatewayApiUrl: process.env.CIRCLE_GATEWAY_API_URL ?? "https://gateway-api-testnet.circle.com",
  circleIrisApiUrl: process.env.CIRCLE_IRIS_API_URL ?? "https://iris-api-sandbox.circle.com",
  geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",

  arcRouterAddress: process.env.ARC_ROUTER_ADDRESS ?? "",
  baseRouterAddress: process.env.BASE_ROUTER_ADDRESS ?? "",
  ethereumRouterAddress: process.env.ETHEREUM_ROUTER_ADDRESS ?? "",
  solanaKaminoAdapterProgramId: process.env.SOLANA_KAMINO_ADAPTER_PROGRAM_ID ?? "",
  solanaRaydiumAdapterProgramId: process.env.SOLANA_RAYDIUM_ADAPTER_PROGRAM_ID ?? "",
  solanaMarinadeAdapterProgramId: process.env.SOLANA_MARINADE_ADAPTER_PROGRAM_ID ?? "",
  kaminoMainMarket: process.env.KAMINO_MAIN_MARKET ?? "",
  aquariusAdapterContractId: process.env.AQUARIUS_ADAPTER_CONTRACT_ID ?? "",
  aquariusRouterContractId: process.env.AQUARIUS_ROUTER_CONTRACT_ID ?? "",
  aquariusPoolContractId: process.env.AQUARIUS_POOL_CONTRACT_ID ?? "",
  blendAdapterContractId: process.env.BLEND_ADAPTER_CONTRACT_ID ?? "",
  blendPoolContractId: process.env.BLEND_POOL_CONTRACT_ID ?? "",
  blendBackstopContractId: process.env.BLEND_BACKSTOP_CONTRACT_ID ?? "",
  blendPoolFactoryContractId: process.env.BLEND_POOL_FACTORY_CONTRACT_ID ?? "",
  solanaKeypairPath: process.env.SOLANA_KEYPAIR_PATH ?? "./keys/solana-devnet.json",
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY ?? "",
  stellarSecretKey: process.env.STELLAR_SECRET_KEY ?? "",
  operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY ?? "",
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY ?? "",
  intentTraceRegistryAddress: process.env.INTENT_TRACE_REGISTRY_ADDRESS ?? process.env.INTENT_TRACE_REGISTRY ?? "",
  intentTraceRegistryChain: process.env.INTENT_TRACE_REGISTRY_CHAIN ?? "ARC",
  intentTraceRecorderPrivateKey: process.env.INTENT_TRACE_RECORDER_PRIVATE_KEY ?? "",
  intentTraceEnabled: process.env.INTENT_TRACE_ENABLED !== "false",
  coingeckoApiUrl: process.env.COINGECKO_API_URL ?? "https://api.coingecko.com/api/v3",
  gatewayTransferFeeBps: Number(process.env.GATEWAY_TRANSFER_FEE_BPS ?? 0.5),
  cctpFastTransferFeeBps: Number(process.env.CCTP_FAST_TRANSFER_FEE_BPS ?? 1),
  cctpMode: process.env.CCTP_MODE ?? "fast",
  bridgekitUnderlyingFeeBps: Number(process.env.BRIDGEKIT_UNDERLYING_FEE_BPS ?? 1),
  balanceMonitorDisabled: process.env.BALANCE_MONITOR_DISABLED === "true",
  balanceMonitorIntervalMs: Number(process.env.BALANCE_MONITOR_INTERVAL_MS ?? 5 * 60 * 1000),
  balanceMonitorNativeThreshold: Number(process.env.BALANCE_MONITOR_NATIVE_THRESHOLD ?? 0.05),
  balanceMonitorUsdcThreshold: Number(process.env.BALANCE_MONITOR_USDC_THRESHOLD ?? 2),

  kaminoEstimatedFeeBps: Number(process.env.KAMINO_ESTIMATED_FEE_BPS ?? 0),
  raydiumEstimatedFeeBps: Number(process.env.RAYDIUM_ESTIMATED_FEE_BPS ?? 25),
  aquariusEstimatedFeeBps: Number(process.env.AQUARIUS_ESTIMATED_FEE_BPS ?? 30),
  usycTellerEstimatedFeeBps: Number(process.env.USYC_TELLER_ESTIMATED_FEE_BPS ?? 0),
  gasUsdArc: Number(process.env.GAS_USD_ARC ?? 0.002),
  gasUsdBaseSepolia: Number(process.env.GAS_USD_BASE_SEPOLIA ?? 0.012),
  gasUsdEthereumSepolia: Number(process.env.GAS_USD_ETHEREUM_SEPOLIA ?? 0.012),
  gasUsdSolanaDevnet: Number(process.env.GAS_USD_SOLANA_DEVNET ?? 0.0002),
  gasUsdStellarTestnet: Number(process.env.GAS_USD_STELLAR_TESTNET ?? 0.0001)
};

export const chainConfig = loadRepoJson<Record<string, any>>("chains.json");
export const protocolConfig = loadRepoJson<Record<string, any[]>>("protocols.json");
export const agentPolicies = loadRepoJson<Record<string, any>>("agent-policies.json");
export const feeModel = loadRepoJson<Record<string, any>>("fee-model.json");


const protocolGroupToChainKey: Record<string, string> = {
  arcTestnet: "ARC",
  baseSepolia: "BASE_SEPOLIA",
  ethereumSepolia: "ETHEREUM_SEPOLIA",
  solanaDevnet: "SOLANA_DEVNET",
  stellarTestnet: "STELLAR_TESTNET"
};

export function protocolGroupForChainKey(chainKey: string): string | undefined {
  return Object.entries(protocolGroupToChainKey).find(([, key]) => key === chainKey)?.[0];
}

export function findProtocolWithChain(key: string): { protocol: any; group: string; chainKey: string } {
  for (const [group, list] of Object.entries(protocolConfig) as Array<[string, any[]]>) {
    const found = list.find((p: any) => p.key === key);
    if (found) return { protocol: found, group, chainKey: protocolGroupToChainKey[group] ?? group };
  }
  throw new Error(`Unsupported protocol: ${key}`);
}

export function findChainByKey(key: string): any {
  const found = Object.values(chainConfig).find((c: any) => c.key === key);
  if (!found) throw new Error(`Unsupported chain: ${key}`);
  return found;
}

export function findProtocol(key: string): any {
  return findProtocolWithChain(key).protocol;
}

export function hasGatewayContracts(chain: any): boolean {
  return Boolean(chain.circle?.gateway?.wallet && chain.circle?.gateway?.minter);
}

export function hasCctpEvmContracts(chain: any): boolean {
  return Boolean(chain.circle?.cctp?.tokenMessengerV2 && chain.circle?.cctp?.messageTransmitterV2);
}
