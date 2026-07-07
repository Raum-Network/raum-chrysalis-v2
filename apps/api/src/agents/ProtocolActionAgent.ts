import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, zeroAddress } from "viem";
import { findChainByKey, findProtocol } from "../config/index.js";
import { CreateIntentInput } from "../types.js";
import { parseUnitsDecimal } from "../utils/amounts.js";

export interface ProtocolActionPayload {
  executionMode: "evm-contract" | "solana-tx" | "stellar-tx" | "x402" | "bridge-only";
  chain: string;
  protocol: string;
  adapterData?: `0x${string}`;
  serviceAction?: Record<string, unknown>;
}

export class ProtocolActionAgent {
  build(input: CreateIntentInput): ProtocolActionPayload {
    const chain = findChainByKey(input.destinationChain);
    const protocol = findProtocol(input.protocol);
    const amount = parseUnitsDecimal(input.amount, 6);
    const spendAvailableAmount = 0n;

    if (protocol.adapter === "bridge_only" || protocol.type === "bridge_transfer") {
      return {
        executionMode: "bridge-only",
        chain: chain.key,
        protocol: protocol.key,
        serviceAction: {
          action: "transfer",
          amount: input.amount,
          asset: input.asset,
          recipient: input.recipient
        }
      };
    }

    if (input.protocol.includes("UNISWAP")) {
      const defaultTokenIn = input.sourceChain === "RIPPLE"
        ? (chain.tokens.WXRP?.address ?? "0xa69f46403f350c33a9486c47c1f24de1c42289fe")
        : chain.tokens.USDC.address;
      const tokenIn = addressFromMetadata(input.metadata?.tokenIn, defaultTokenIn);
      const tokenOut = addressFromMetadata(input.metadata?.tokenOut, chain.tokens.USDC.address);
      const feeTier = Number(input.metadata?.fee ?? 500);
      const recipient = addressFromMetadata(input.recipient, zeroAddress);
      const swapKind = String(input.metadata?.swapKind ?? "exactInputSingle");
      const action = uniswapAction(swapKind);
      const amountOutMinimum = bigintFromMetadata(input.metadata?.amountOutMinimum, 0n);
      const amountOut = bigintFromMetadata(input.metadata?.amountOut, amount);
      const amountInMaximum = bigintFromMetadata(input.metadata?.amountInMaximum, amount);
      const sqrtPriceLimitX96 = bigintFromMetadata(input.metadata?.sqrtPriceLimitX96, 0n);
      const path = hexFromMetadata(input.metadata?.path);
      const params = encodeUniswapParams({
        action,
        tokenIn,
        tokenOut,
        feeTier,
        recipient,
        amount: spendAvailableAmount,
        amountOut,
        amountInMaximum,
        amountOutMinimum,
        sqrtPriceLimitX96,
        path
      });

      return {
        executionMode: "evm-contract",
        chain: chain.key,
        protocol: protocol.key,
        adapterData: encodeAbiParameters(
          parseAbiParameters("(uint8 action,address tokenIn,bytes params,address refundTo)"),
          [{ action, tokenIn, params, refundTo: recipient }]
        ),
        serviceAction: { tokenIn, tokenOut, feeTier, recipient, swapKind }
      };
    }

    if (input.protocol === "ETH_AAVE_V3") {
      const defaultTokenIn = input.sourceChain === "RIPPLE"
        ? (chain.tokens.WXRP?.address ?? "0xa69f46403f350c33a9486c47c1f24de1c42289fe")
        : chain.tokens.USDC.address;
      const tokenIn = addressFromMetadata(input.metadata?.tokenIn ?? defaultTokenIn, zeroAddress);
      const tokenOut = addressFromMetadata(input.metadata?.tokenOut, "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c");
      const fee = Number(input.metadata?.fee ?? 3000);
      const amountOutMin = bigintFromMetadata(input.metadata?.amountOutMin, 0n);
      const recipient = addressFromMetadata(input.recipient, zeroAddress);
      
      return {
        executionMode: "evm-contract",
        chain: chain.key,
        protocol: protocol.key,
        adapterData: encodeAbiParameters(
          parseAbiParameters("(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint256 amountOutMin,address onBehalfOf,uint16 referralCode)"),
          [{
            tokenIn,
            tokenOut,
            fee,
            amountIn: spendAvailableAmount,
            amountOutMin,
            onBehalfOf: recipient,
            referralCode: 0
          }]
        )
      };
    }

    if (input.protocol === "BASE_MORPHO_BLUE") {
      const morphoAction = morphoActionId(String(input.metadata?.morphoAction ?? input.action));
      const market = morphoMarketFromMetadata(input.metadata?.market, chain.tokens.USDC.address);
      const recipient = addressFromMetadata(input.recipient, zeroAddress);
      const receiver = addressFromMetadata(input.metadata?.receiver, recipient);
      const onBehalf = addressFromMetadata(input.metadata?.onBehalf ?? input.metadata?.onBehalfOf, recipient);
      return {
        executionMode: "evm-contract",
        chain: chain.key,
        protocol: protocol.key,
        adapterData: encodeAbiParameters(
          parseAbiParameters("(uint8 action,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) market,uint256 assets,uint256 shares,address onBehalf,address receiver,bytes data)"),
          [{
            action: morphoAction,
            market,
            assets: bigintFromMetadata(input.metadata?.assets, ["supply", "supply_collateral", "repay"].includes(input.action) ? spendAvailableAmount : amount),
            shares: bigintFromMetadata(input.metadata?.shares, 0n),
            onBehalf,
            receiver,
            data: hexFromMetadata(input.metadata?.data)
          }]
        ),
        serviceAction: { action: morphoAction, market, recipient, receiver, onBehalf }
      };
    }

    if (chain.vm === "svm") {
      return {
        executionMode: "solana-tx",
        chain: chain.key,
        protocol: protocol.key,
        serviceAction: {
          programId: protocol.programId,
          action: input.action,
          amount: input.amount,
          asset: input.asset,
          recipient: input.recipient,
          ...(input.metadata ?? {})
        }
      };
    }

    if (chain.vm === "soroban") {
      return {
        executionMode: "stellar-tx",
        chain: chain.key,
        protocol: protocol.key,
        serviceAction: {
          network: "testnet",
          action: input.action,
          amount: input.amount,
          asset: input.asset,
          recipient: input.recipient,
          protocolConfig: protocol,
          ...(input.metadata ?? {})
        }
      };
    }

    if (input.protocol === "ARC_NANOPAYMENTS") {
      return {
        executionMode: "x402",
        chain: chain.key,
        protocol: protocol.key,
        serviceAction: {
          price: input.amount,
          resource: input.metadata?.resource ?? "/paid/route-alpha"
        }
      };
    }

    if (input.protocol === "ARC_USYC_TELLER") {
      const tellerAddress = addressFromMetadata(chain.circle?.usyc?.teller, zeroAddress);
      const usycAddress = addressFromMetadata(chain.tokens?.USYC?.address, zeroAddress);
      const usdcAddress = addressFromMetadata(chain.tokens?.USDC?.address, zeroAddress);
      const action = input.action === "sell" ? "redeem" : "deposit";
      const receiver = addressFromMetadata(input.recipient, zeroAddress);
      const parsedAmount = parseUnitsDecimal(input.amount, 6);

      const tellerAbi = parseAbi([
        "function deposit(uint256 assets, address receiver) returns (uint256)",
        "function redeem(uint256 shares, address receiver, address account) returns (uint256)"
      ]);

      const callData = encodeFunctionData({
        abi: tellerAbi,
        functionName: action,
        args: action === "deposit"
          ? [parsedAmount, receiver]
          : [parsedAmount, receiver, receiver]
      });

      return {
        executionMode: "evm-contract",
        chain: chain.key,
        protocol: protocol.key,
        adapterData: encodeAbiParameters(
          parseAbiParameters("(address tokenIn,uint256 amount,address approvalTarget,address target,bytes callData,address refundToken)"),
          [{
            tokenIn: usdcAddress,
            amount: parsedAmount,
            approvalTarget: tellerAddress,
            target: tellerAddress,
            callData,
            refundToken: usycAddress
          }]
        ),
        serviceAction: { action, usycAddress, tellerAddress, receiver }
      };
    }

    return {
      executionMode: "evm-contract",
      chain: chain.key,
      protocol: protocol.key,
      serviceAction: {
        note: "Generic Arc adapter action. Provide target, calldata, and selector allowlist.",
        metadata: input.metadata ?? {}
      }
    };
  }
}

function addressFromMetadata(value: unknown, fallback: `0x${string}`): `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)
    ? value.toLowerCase() as `0x${string}`
    : fallback.toLowerCase() as `0x${string}`;
}

function hexFromMetadata(value: unknown): `0x${string}` {
  return typeof value === "string" && value.startsWith("0x") ? value as `0x${string}` : "0x";
}

function bigintFromMetadata(value: unknown, fallback: bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && value.trim()) return BigInt(value);
  return fallback;
}

function uniswapAction(kind: string): number {
  if (kind === "exactInput") return 1;
  if (kind === "exactOutputSingle") return 2;
  if (kind === "exactOutput") return 3;
  return 0;
}

function encodeUniswapParams(input: {
  action: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  feeTier: number;
  recipient: `0x${string}`;
  amount: bigint;
  amountOut: bigint;
  amountInMaximum: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
  path: `0x${string}`;
}): `0x${string}` {
  if (input.action === 1) {
    return encodeAbiParameters(
      parseAbiParameters("(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)"),
      [{ path: input.path, recipient: input.recipient, amountIn: input.amount, amountOutMinimum: input.amountOutMinimum }]
    );
  }
  if (input.action === 2) {
    return encodeAbiParameters(
      parseAbiParameters("(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)"),
      [{
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        fee: input.feeTier,
        recipient: input.recipient,
        amountOut: input.amountOut,
        amountInMaximum: input.amountInMaximum,
        sqrtPriceLimitX96: input.sqrtPriceLimitX96
      }]
    );
  }
  if (input.action === 3) {
    return encodeAbiParameters(
      parseAbiParameters("(bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum)"),
      [{ path: input.path, recipient: input.recipient, amountOut: input.amountOut, amountInMaximum: input.amountInMaximum }]
    );
  }
  return encodeAbiParameters(
    parseAbiParameters("(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)"),
    [{
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      fee: input.feeTier,
      recipient: input.recipient,
      amountIn: input.amount,
      amountOutMinimum: input.amountOutMinimum,
      sqrtPriceLimitX96: input.sqrtPriceLimitX96
    }]
  );
}

function morphoActionId(action: string): number {
  const normalized = action.toLowerCase();
  if (normalized === "supply_collateral" || normalized === "supplycollateral" || normalized === "collateral") return 1;
  if (normalized === "withdraw") return 2;
  if (normalized === "withdraw_collateral" || normalized === "withdrawcollateral") return 3;
  if (normalized === "borrow") return 4;
  if (normalized === "repay") return 5;
  return 0;
}

function morphoMarketFromMetadata(value: unknown, fallbackLoanToken: `0x${string}`) {
  const market = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    loanToken: addressFromMetadata(market.loanToken, fallbackLoanToken),
    collateralToken: addressFromMetadata(market.collateralToken, zeroAddress),
    oracle: addressFromMetadata(market.oracle, zeroAddress),
    irm: addressFromMetadata(market.irm, zeroAddress),
    lltv: bigintFromMetadata(market.lltv, 0n)
  };
}
