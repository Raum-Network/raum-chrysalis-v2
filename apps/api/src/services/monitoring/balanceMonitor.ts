import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Horizon, Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import { chainConfig, env } from "../../config/index.js";
import { loadSolanaKeypair as loadSolanaKeypairUtil } from "../../utils/solanaKeys.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }]
  }
] as const;

export interface BalanceCheck {
  chain: string;
  account: string;
  asset: string;
  balance: string;
  threshold: string;
  ok: boolean;
  note?: string;
}

export class BalanceMonitorService {
  private timer?: NodeJS.Timeout;

  start() {
    if (env.balanceMonitorDisabled) {
      console.log("[BalanceMonitor] Disabled by BALANCE_MONITOR_DISABLED=true");
      return;
    }
    if (this.timer) return;

    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), env.balanceMonitorIntervalMs);
    this.timer.unref?.();
    console.log(`[BalanceMonitor] Watching native + USDC balances every ${Math.round(env.balanceMonitorIntervalMs / 1000)}s`);
  }

  async checkNow(): Promise<{ checks: BalanceCheck[]; warnings: BalanceCheck[] }> {
    const checks: BalanceCheck[] = [];
    for (const chain of Object.values(chainConfig) as any[]) {
      try {
        if (chain.vm === "evm") checks.push(...await this.checkEvmChain(chain));
        if (chain.vm === "svm") checks.push(...await this.checkSolanaChain(chain));
        if (chain.vm === "soroban") checks.push(...await this.checkStellarChain(chain));
      } catch (err) {
        checks.push({
          chain: chain.key,
          account: "unavailable",
          asset: "monitor",
          balance: "0",
          threshold: "0",
          ok: false,
          note: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const warnings = checks.filter((check) => !check.ok);
    for (const warning of warnings) {
      console.warn(
        `[BalanceMonitor] LOW ${warning.chain} ${warning.asset}: ${warning.balance} ` +
        `< ${warning.threshold}. Fund ${warning.account}${warning.note ? ` (${warning.note})` : ""}.`
      );
    }
    if (!warnings.length) console.log(`[BalanceMonitor] OK ${checks.length} balances checked.`);
    return { checks, warnings };
  }

  private async checkEvmChain(chain: any): Promise<BalanceCheck[]> {
    const account = monitoredAddressForChain(chain);
    if (!account) {
      return [missingCheck(chain.key, "EVM account", "Set OPERATOR_PRIVATE_KEY, the router address env var, or BALANCE_MONITOR_<CHAIN>_ADDRESS.")];
    }

    const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
    const client = createPublicClient({
      chain: {
        id: chain.chainId,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency ?? { name: "Native", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
      },
      transport: http(rpcUrl)
    });

    const nativeDecimals = Number(chain.nativeCurrency?.decimals ?? 18);
    const nativeSymbol = String(chain.nativeCurrency?.symbol ?? "NATIVE");
    const nativeRaw = await client.getBalance({ address: account as Address });
    const native = Number(formatUnits(nativeRaw, nativeDecimals));

    const checks: BalanceCheck[] = [
      makeCheck(chain.key, account, nativeSymbol, native, env.balanceMonitorNativeThreshold)
    ];

    const usdc = chain.tokens?.USDC;
    if (usdc?.address) {
      const usdcRaw = await client.readContract({
        address: usdc.address as Address,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [account as Address]
      }) as bigint;
      const usdcAmount = Number(formatUnits(usdcRaw, Number(usdc.decimals ?? 6)));
      checks.push(makeCheck(chain.key, account, "USDC", usdcAmount, env.balanceMonitorUsdcThreshold));
    }

    return checks;
  }

  private async checkSolanaChain(chain: any): Promise<BalanceCheck[]> {
    const owner = monitoredSolanaAddress(chain.key);
    if (!owner) {
      return [missingCheck(chain.key, "Solana account", "Set SOLANA_KEYPAIR_PATH or BALANCE_MONITOR_SOLANA_DEVNET_ADDRESS.")];
    }

    const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
    const connection = new Connection(rpcUrl, "confirmed");
    const ownerKey = new PublicKey(owner);
    const sol = await connection.getBalance(ownerKey, "confirmed") / LAMPORTS_PER_SOL;
    const checks = [makeCheck(chain.key, owner, "SOL", sol, env.balanceMonitorNativeThreshold)];

    const usdc = chain.tokens?.USDC;
    if (usdc?.mint) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(usdc.mint), ownerKey, false);
      let amount = 0;
      try {
        const balance = await connection.getTokenAccountBalance(ata, "confirmed");
        amount = Number(balance.value.uiAmountString ?? balance.value.uiAmount ?? 0);
      } catch {
        amount = 0;
      }
      checks.push(makeCheck(chain.key, ata.toBase58(), "USDC", amount, env.balanceMonitorUsdcThreshold));
    }

    return checks;
  }

  private async checkStellarChain(chain: any): Promise<BalanceCheck[]> {
    const account = monitoredStellarAddress(chain.key);
    if (!account) {
      return [missingCheck(chain.key, "Stellar account", "Set STELLAR_SECRET_KEY, STELLAR_PUBLIC_KEY, or BALANCE_MONITOR_STELLAR_TESTNET_ADDRESS.")];
    }

    const horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
    const server = new Horizon.Server(horizonUrl);
    const loaded = await server.loadAccount(account);
    const nativeBalance = loaded.balances.find((balance: any) => balance.asset_type === "native") as any;
    const checks = [
      makeCheck(chain.key, account, "XLM", Number(nativeBalance?.balance ?? 0), env.balanceMonitorNativeThreshold)
    ];

    const usdc = chain.tokens?.USDC;
    if (usdc?.assetCode && usdc?.assetIssuer) {
      const usdcBalance = loaded.balances.find((balance: any) =>
        balance.asset_code === usdc.assetCode && balance.asset_issuer === usdc.assetIssuer
      ) as any;
      checks.push(makeCheck(chain.key, account, "USDC", Number(usdcBalance?.balance ?? 0), env.balanceMonitorUsdcThreshold));
    }

    return checks;
  }
}

function makeCheck(chain: string, account: string, asset: string, balance: number, threshold: number): BalanceCheck {
  return {
    chain,
    account,
    asset,
    balance: formatAmount(balance),
    threshold: formatAmount(threshold),
    ok: balance >= threshold
  };
}

function missingCheck(chain: string, asset: string, note: string): BalanceCheck {
  return { chain, account: "unconfigured", asset, balance: "0", threshold: "configured account", ok: false, note };
}

function monitoredAddressForChain(chain: any): string | undefined {
  const override = process.env[`BALANCE_MONITOR_${chain.key}_ADDRESS`];
  if (override) return override;
  if (chain.key === "ARC") return env.arcRouterAddress || operatorAddress();
  if (chain.key === "BASE_SEPOLIA") return env.baseRouterAddress || operatorAddress();
  if (chain.key === "ETHEREUM_SEPOLIA") return env.ethereumRouterAddress || operatorAddress();
  return operatorAddress();
}

function monitoredSolanaAddress(chainKey: string): string | undefined {
  const override = process.env[`BALANCE_MONITOR_${chainKey}_ADDRESS`];
  if (override) return override;
  const keypair = loadSolanaKeypair();
  return keypair?.publicKey.toBase58();
}

function monitoredStellarAddress(chainKey: string): string | undefined {
  const override = process.env[`BALANCE_MONITOR_${chainKey}_ADDRESS`] ?? process.env.STELLAR_PUBLIC_KEY;
  if (override) return override;
  if (!env.stellarSecretKey) return undefined;
  try {
    return StellarKeypair.fromSecret(env.stellarSecretKey).publicKey();
  } catch {
    return undefined;
  }
}

function operatorAddress(): string | undefined {
  if (!env.operatorPrivateKey) return undefined;
  try {
    return privateKeyToAccount(env.operatorPrivateKey as `0x${string}`).address;
  } catch {
    return undefined;
  }
}

function loadSolanaKeypair(): Keypair | undefined {
  return loadSolanaKeypairUtil();
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  if (value < 0.000001) return value.toExponential(2);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export const balanceMonitor = new BalanceMonitorService();
