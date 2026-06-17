import { createHash } from "node:crypto";
import { env, findProtocol } from "../../config/index.js";
import { formatUnitsDecimal, parseUnitsDecimal } from "../../utils/amounts.js";
import { resolveStellarAdapterPayload } from "./nonEvmPayloads.js";
import { simulateStellarAdapter, submitStellarAdapter } from "./stellarAdapterSubmitter.js";
import { stellarStroopsFeeLine, sumFeeLinesUsd } from "../fees/transactionFeeUtils.js";
import { nativeToScVal, xdr, Address, Keypair, StrKey } from "@stellar/stellar-sdk";

export interface AquariusAdapterAction {
  intentId?: string;
  recipient?: string;
  action?: "SwapChained" | "SwapChainedStrictReceive" | "Deposit" | "Withdraw";
  method?: string;
  targetContractId?: string;
  argsXdr?: string[];
  scVals?: unknown[];
  args?: unknown[];
  amount?: string;
  amountRaw?: string;
  executionAmount?: string;
  amountIn?: string;
  amountInRaw?: string;
  minAmountOut?: string;
  minAmountOutRaw?: string;
  memo?: string;
  asset?: string;
  tokenOut?: string;
  simulateOnly?: boolean;
}

const STELLAR_TOKENS: Record<string, string> = {
  USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
};

const AQUARIUS_POOLS: Record<string, { poolHash: string; poolAddress: string }> = {
  "USDC-XLM": {
    poolHash: "9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e",
    poolAddress: "CAYBMZYJCOMMOHOGOGBK7ANIKF3JPZAL4D7SWAPVPHC4WBMOUT5DJN5B",
  },
};

const ROUTER_METHOD_BY_ACTION: Record<string, string> = {
  SwapChained: "swap_chained",
  SwapChainedStrictReceive: "swap_chained_strict_receive",
  Deposit: "deposit",
  Withdraw: "withdraw"
};

export class AquariusService {
  async buildAndMaybeSubmit(action: AquariusAdapterAction): Promise<Record<string, unknown>> {
    const protocol = findProtocol("XLM_AQUARIUS");
    const selectedAction = normalizeAquariusAction(action.action);
    const isSwapAction = selectedAction === "SwapChained" || selectedAction === "SwapChainedStrictReceive";
    const resolvedTokenIn = resolveTokenIn(action);
    const resolvedTokenOut = resolveTokenOut(action, resolvedTokenIn);
    const resolvedAmountOutSymbol = tokenSymbol(resolvedTokenOut);
    const defaultPool = env.aquariusPoolContractId || AQUARIUS_POOLS["USDC-XLM"].poolAddress;
    const targetContract = action.targetContractId
      || (isSwapAction ? defaultPool : env.aquariusRouterContractId)
      || `<${protocol.routerContractEnv}>`;
    const payload = resolveStellarAdapterPayload({
      argsXdr: action.argsXdr,
      scVals: action.scVals,
      args: action.args
    });
    let resolvedArgsXdr = payload?.argsXdr ?? action.argsXdr;
    if (!resolvedArgsXdr?.length) {
      try {
        const secret = env.stellarSecretKey || process.env.STELLAR_SECRET_KEY;
        const caller = secret ? Keypair.fromSecret(secret).publicKey() : Keypair.random().publicKey();
        const STELLAR_DECIMALS = 7;
        const rawAmountIn = rawOrDecimalAmount(
          action.amountInRaw ?? action.amountRaw,
          action.amountIn ?? action.executionAmount ?? action.amount ?? "0",
          STELLAR_DECIMALS
        );
        const rawMinOut = rawOrDecimalAmount(
          action.minAmountOutRaw,
          action.minAmountOut ?? "0",
          STELLAR_DECIMALS
        );

        if (isSwapAction) {
          const pairKey = findPoolPairKey(resolvedTokenIn, resolvedTokenOut);
          const pool = pairKey ? AQUARIUS_POOLS[pairKey] : undefined;
          const poolAddress = action.targetContractId || env.aquariusPoolContractId || pool?.poolAddress || defaultPool;
          const [inIdx, outIdx] = poolTokenIndexes(resolvedTokenIn, resolvedTokenOut);
          resolvedArgsXdr = buildDirectSwapArgsXdr({
            caller,
            intentId: action.intentId ?? "",
            poolAddress,
            inIdx,
            outIdx,
            amountIn: rawAmountIn,
            minAmountOut: rawMinOut,
            memo: action.memo ?? "Chrysalis V2 Aquarius intent"
          });
        } else if (selectedAction === "Deposit") {
          resolvedArgsXdr = [
            nativeToScVal(new Address(caller)).toXDR("base64"),
            nativeToScVal(rawAmountIn, { type: "i128" }).toXDR("base64")
          ];
        } else if (selectedAction === "Withdraw") {
          resolvedArgsXdr = [
            nativeToScVal(new Address(caller)).toXDR("base64"),
            nativeToScVal(rawAmountIn, { type: "i128" }).toXDR("base64")
          ];
        }
      } catch (err) {
        console.error("Aquarius Soroban arguments builder failed:", err);
      }
    }

    const isConfigured = Boolean(
      env.aquariusAdapterContractId
      && (isSwapAction ? defaultPool : env.aquariusRouterContractId)
    );
    const operation = {
      networkPassphrase: "Test SDF Network ; September 2015",
      contract: env.aquariusAdapterContractId || `<${protocol.adapterContractEnv}>`,
      method: isSwapAction ? "swap_direct" : "execute",
      args: {
        caller: "<stellar-agent-or-user-address>",
        intentId: action.intentId ?? "<intent-id-bytes32>",
        action: selectedAction,
        target: targetContract,
        method: isSwapAction ? "swap" : action.method ?? ROUTER_METHOD_BY_ACTION[selectedAction],
        argsXdr: resolvedArgsXdr ?? ["<Soroban Val XDRs from Aquarius path-finding>"],
        amountIn: action.amountInRaw ?? action.amountIn ?? action.amountRaw ?? action.executionAmount ?? action.amount ?? "0",
        minAmountOut: action.minAmountOutRaw ?? action.minAmountOut ?? "0",
        memo: action.memo ?? "Chrysalis V2 Aquarius intent",
        relay: action.recipient?.trim() ? {
          recipient: action.recipient.trim(),
          token: relayTokenForAction(action)
        } : undefined
      }
    };

    if (action.simulateOnly && isConfigured && resolvedArgsXdr?.length) {
      const result = await simulateStellarAdapter({
        protocol: "aquarius",
        adapterContractId: env.aquariusAdapterContractId,
        targetContractId: targetContract,
        targetMethod: isSwapAction ? "swap" : action.method ?? ROUTER_METHOD_BY_ACTION[selectedAction],
        intentId: action.intentId ?? "simulation",
        action: selectedAction,
        argsXdr: resolvedArgsXdr!,
        amount: rawOrDecimalAmount(action.amountInRaw ?? action.amountRaw, action.amountIn ?? action.executionAmount ?? action.amount, 7),
        minAmountOut: rawOrDecimalAmount(action.minAmountOutRaw, action.minAmountOut, 7),
        memo: action.memo ?? "Chrysalis V2 Aquarius intent",
        relay: action.recipient?.trim() ? {
          recipient: action.recipient.trim(),
          token: relayTokenForAction(action)
        } : undefined,
        directMethod: isSwapAction ? "swap_direct" : undefined
      });
      return {
        status: "simulated",
        executable: true,
        chain: "STELLAR_TESTNET",
        protocol: protocol.key,
        adapter: protocol.adapter,
        adapterContractId: env.aquariusAdapterContractId,
        targetContract,
        amountOut: result.amountOut,
        amountOutRaw: result.amountOut,
        amountOutFormatted: result.amountOut ? formatUnitsDecimal(BigInt(result.amountOut), 7) : undefined,
        amountOutSymbol: isSwapAction ? resolvedAmountOutSymbol : undefined,
        simulation: result,
        operation
      };
    }

    if (!env.agentDryRun && isConfigured && resolvedArgsXdr?.length) {
      try {
        const result = isSwapAction
          ? await submitStellarAdapter({
              protocol: "aquarius",
              adapterContractId: env.aquariusAdapterContractId,
              targetContractId: targetContract,
              targetMethod: "swap",
              intentId: action.intentId ?? "",
              action: selectedAction,
              argsXdr: resolvedArgsXdr!,
              amount: rawOrDecimalAmount(action.amountInRaw ?? action.amountRaw, action.amountIn ?? action.executionAmount ?? action.amount, 7),
              minAmountOut: rawOrDecimalAmount(action.minAmountOutRaw, action.minAmountOut, 7),
              memo: action.memo ?? "Chrysalis V2 Aquarius intent",
              relay: action.recipient?.trim() ? {
                recipient: action.recipient.trim(),
                token: relayTokenForAction(action)
              } : undefined,
              directMethod: "swap_direct"
            })
          : await submitStellarAdapter({
              protocol: "aquarius",
              adapterContractId: env.aquariusAdapterContractId,
              targetContractId: targetContract,
              targetMethod: action.method ?? ROUTER_METHOD_BY_ACTION[selectedAction],
              intentId: action.intentId ?? "",
              action: selectedAction,
              argsXdr: resolvedArgsXdr!,
              amount: rawOrDecimalAmount(action.amountInRaw ?? action.amountRaw, action.amountIn ?? action.executionAmount ?? action.amount, 7),
              minAmountOut: rawOrDecimalAmount(action.minAmountOutRaw, action.minAmountOut, 7),
              memo: action.memo ?? "Chrysalis V2 Aquarius intent",
              relay: action.recipient?.trim() ? {
                recipient: action.recipient.trim(),
                token: relayTokenForAction(action)
              } : undefined
            });
        const feeLines = [
          result.feeStroops
            ? await stellarStroopsFeeLine({
                label: "Aquarius Stellar execution",
                feeStroops: result.feeStroops,
                txHash: result.hash,
                payer: "developer"
              })
            : null,
          result.relayFeeStroops && result.relayHash
            ? await stellarStroopsFeeLine({
                label: "Aquarius Stellar token relay",
                feeStroops: result.relayFeeStroops,
                txHash: result.relayHash,
                payer: "developer"
              })
            : null
        ].filter((line): line is Awaited<ReturnType<typeof stellarStroopsFeeLine>> => Boolean(line));

        return {
          status: "succeeded",
          executable: true,
          chain: "STELLAR_TESTNET",
          protocol: protocol.key,
          adapter: protocol.adapter,
          adapterContractId: result.adapterContractId,
          targetContract,
          stellarTxHash: result.hash,
          stellarRelayTxHash: result.relayHash,
          feeLines,
          actualFeeUsd: sumFeeLinesUsd(feeLines),
          amountOut: result.amountOut,
          amountOutRaw: result.amountOut,
          amountOutFormatted: result.amountOut ? formatUnitsDecimal(BigInt(result.amountOut), 7) : undefined,
          amountOutSymbol: isSwapAction ? resolvedAmountOutSymbol : undefined,
          operation
        };
      } catch (err) {
        return {
          status: "failed",
          executable: true,
          chain: "STELLAR_TESTNET",
          protocol: protocol.key,
          adapter: protocol.adapter,
          adapterContractId: env.aquariusAdapterContractId,
          targetContract,
          operation,
          note: err instanceof Error ? err.message : String(err)
        };
      }
    }

    const argsAvailable = Boolean(resolvedArgsXdr?.length);
    return {
      status: env.agentDryRun ? "planned" : isConfigured && argsAvailable ? "builder_only" : "not_configured",
      chain: "STELLAR_TESTNET",
      protocol: protocol.key,
      adapter: protocol.adapter,
      executable: false,
      adapterContractId: env.aquariusAdapterContractId || `<${protocol.adapterContractEnv}>`,
      targetContract,
      operation,
      safetyChecks: [
        isSwapAction ? "adapter validates the pinned Aquarius pool contract" : "adapter validates router target contract",
        "adapter validates the Aquarius method allowed for the selected action",
        "adapter records a persistent Soroban receipt after successful invoke_contract"
      ],
      note: !isConfigured
        ? "Aquarius live execution is not configured. Set AQUARIUS_ADAPTER_CONTRACT_ID and AQUARIUS_POOL_CONTRACT_ID/AQUARIUS_ROUTER_CONTRACT_ID in .env."
        : !argsAvailable
        ? "Aquarius Soroban argsXdr could not be built. Provide argsXdr, args, or scVals in the intent metadata, or fix the dynamic builder error."
        : "Aquarius adapter payload is fully built. AGENT_DRY_RUN is enabled, so the live Soroban adapter transaction was not submitted."
    };
  }
}

function strkeyToAddress(id: string): Address {
  if (id.startsWith("G")) {
    if (!StrKey.isValidEd25519PublicKey(id)) {
      console.error(`[strkeyToAddress] invalid G address: "${id}"`);
      return new Address("GDQRVBRO5CGIY6DT4MFYIE7LP2QPYGMMYQN5AHJ4CZE3MAQASHXH46B6");
    }
    return new Address(id);
  }
  if (!StrKey.isValidContract(id)) {
    console.error(`[strkeyToAddress] invalid C address: "${id}"`);
    return strkeyToAddress(STELLAR_TOKENS.USDC);
  }
  return Address.contract(StrKey.decodeContract(id));
}

function pairedToken(token: string): string {
  const usdc = STELLAR_TOKENS.USDC;
  const xlm = STELLAR_TOKENS.XLM;
  if (token === usdc) return xlm;
  if (token === xlm) return usdc;
  return usdc;
}

function findPoolPairKey(tokenA: string, tokenB: string): string | undefined {
  const usdc = STELLAR_TOKENS.USDC;
  const xlm = STELLAR_TOKENS.XLM;
  if (tokenA === usdc && tokenB === xlm) return "USDC-XLM";
  if (tokenA === xlm && tokenB === usdc) return "USDC-XLM";
  return undefined;
}

function poolTokenIndexes(tokenIn: string, tokenOut: string): [number, number] {
  const usdc = STELLAR_TOKENS.USDC;
  const xlm = STELLAR_TOKENS.XLM;
  if (tokenIn === usdc && tokenOut === xlm) return [0, 1];
  if (tokenIn === xlm && tokenOut === usdc) return [1, 0];
  return [0, 1];
}

function buildDirectSwapArgsXdr(input: {
  caller: string;
  intentId: string;
  poolAddress: string;
  inIdx: number;
  outIdx: number;
  amountIn: bigint;
  minAmountOut: bigint;
  memo: string;
}): string[] {
  return [
    nativeToScVal(new Address(input.caller)).toXDR("base64"),
    nativeToScVal(intentIdBytes(input.intentId)).toXDR("base64"),
    nativeToScVal(strkeyToAddress(input.poolAddress)).toXDR("base64"),
    nativeToScVal(input.inIdx, { type: "u32" }).toXDR("base64"),
    nativeToScVal(input.outIdx, { type: "u32" }).toXDR("base64"),
    nativeToScVal(input.amountIn, { type: "u128" }).toXDR("base64"),
    nativeToScVal(input.minAmountOut, { type: "u128" }).toXDR("base64"),
    nativeToScVal(input.memo).toXDR("base64"),
    xdr.ScVal.scvVoid().toXDR("base64")
  ];
}

function relayTokenForAction(action: AquariusAdapterAction): string {
  return resolveTokenOut(action);
}

function resolveTokenIn(action: AquariusAdapterAction): string {
  return action.memo?.split("tokenIn:")[1]?.split(" ")[0]
    || STELLAR_TOKENS[action.asset ?? ""]
    || STELLAR_TOKENS.USDC;
}

function resolveTokenOut(action: AquariusAdapterAction, tokenIn = resolveTokenIn(action)): string {
  return action.memo?.split("tokenOut:")[1]?.split(" ")[0]
    || action.tokenOut
    || pairedToken(tokenIn);
}

function tokenSymbol(token: string): string | undefined {
  for (const [symbol, contract] of Object.entries(STELLAR_TOKENS)) {
    if (contract === token) return symbol;
  }
  return undefined;
}

function intentIdBytes(intentId: string): Buffer {
  const normalized = intentId.startsWith("0x") ? intentId.slice(2) : intentId;
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return Buffer.from(normalized, "hex");
  return createHash("sha256").update(intentId).digest();
}

function normalizeAquariusAction(action: unknown): NonNullable<AquariusAdapterAction["action"]> {
  if (action === "SwapChainedStrictReceive" || action === "Deposit" || action === "Withdraw" || action === "SwapChained") return action;
  return "SwapChained";
}

function rawAmount(value: unknown, decimals: number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && value.trim()) return parseUnitsDecimal(value, decimals);
  return 0n;
}

function rawOrDecimalAmount(rawValue: unknown, decimalValue: unknown, decimals: number): bigint {
  if (typeof rawValue === "bigint") return rawValue;
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) return BigInt(Math.floor(rawValue));
  if (typeof rawValue === "string" && /^[0-9]+$/.test(rawValue.trim())) return BigInt(rawValue.trim());
  return rawAmount(decimalValue, decimals);
}
