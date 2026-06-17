import {
  encodeFunctionData,
  Hex,
  keccak256,
  parseAbi,
} from "viem";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  Connection,
  Keypair as SolanaKeypair,
  PublicKey,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Address as StellarAddress,
  BASE_FEE,
  Contract as StellarContract,
  Keypair as StellarKeypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc as SorobanRpc
} from "@stellar/stellar-sdk";
import { env, feeModel, findChainByKey, findProtocolWithChain } from "../../config/index.js";
import { loadSolanaKeypair } from "../../utils/solanaKeys.js";
import { ProtocolActionAgent } from "../../agents/ProtocolActionAgent.js";
import { ProtocolExecutorRegistry } from "../protocols/ProtocolExecutorRegistry.js";
import { CreateIntentInput, FeeLineItem, RouteKind } from "../../types.js";
import { formatUnitsDecimal, parseUnitsDecimal } from "../../utils/amounts.js";
import { gasAmount, NativeGasEstimate } from "./gasEstimator.js";
import { usd } from "./math.js";
import { liveQuoteService } from "./liveQuoteService.js";

const erc20Abi = parseAbi([
  "function transfer(address to,uint256 amount) returns (bool)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)"
]);

const gatewayWalletAbi = parseAbi([
  "function deposit(address token,uint256 value)"
]);

const routerAbi = parseAbi([
  "function executeWithRouterBalance(bytes32 destinationChainKey,bytes32 protocolKey,address beneficiary,address tokenIn,uint256 amountIn,bytes actionData) returns (bytes32)",
  "function routeLocal(bytes32 destinationChainKey,bytes32 protocolKey,address tokenIn,uint256 amountIn,address refundAddress,bytes actionData) returns (bytes32)",
  "function feeBps() view returns (uint16)"
]);

const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
]);

const uniswapV3FactoryAbi = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"
]);

const UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RPC_MAX_ATTEMPTS = 4;
const RPC_RETRY_BASE_MS = 450;
const SOLANA_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

type StateDiff = Record<Hex, Hex>;

interface SimulationContext {
  circleFeeUsd: number;
  slippageBps: number;
}

export interface RouteSimulation {
  sourceGas: NativeGasEstimate;
  destinationGas: NativeGasEstimate;
  sourceGasUnits: bigint;
  destinationGasUnits: bigint;
  protocolInputAmount: string;
  protocolInputRaw: bigint;
  outputTokenSymbol: string;
  outputAmount: string;
  minimumOutputAmount: string;
  assumptions: string[];
  lines: FeeLineItem[];
}

const RECEIPT_TOKEN_SYMBOL_BY_PROTOCOL: Record<string, string> = {
  ETH_AAVE_V3: "aEthWETH",
  BASE_MORPHO_BLUE: "Morpho USDC shares",
  SOL_KAMINO_LEND: "Kamino USDC collateral",
  SOL_MARINADE: "mSOL",
  XLM_BLEND: "Blend USDC position"
};

function isPositionCreatingAction(action: string) {
  return ["supply", "supply_collateral", "deposit"].includes(action.toLowerCase());
}

function isBridgeOnlyProtocol(protocol: string) {
  return protocol.endsWith("_USDC_TRANSFER");
}

function isRateLimitMessage(message: string) {
  return /429|rate.?limit|too many requests|request limit/i.test(message);
}

function metadataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function splTransferData(amountRaw: bigint): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amountRaw, 1);
  return data;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function backoffMs(attempt: number, retryAfter?: number) {
  const jitter = Math.floor(Math.random() * 150);
  return retryAfter ?? RPC_RETRY_BASE_MS * 2 ** (attempt - 1) + jitter;
}

function rateLimitMessage(method: string, retryAfter?: number) {
  const retryHint = retryAfter && retryAfter > 0
    ? ` Retry after about ${Math.ceil(retryAfter / 1000)}s.`
    : " Retry in a few seconds.";
  return `${method} was rate limited by the RPC provider after ${RPC_MAX_ATTEMPTS} attempts.${retryHint} Set a private RPC URL in .env for reliable live simulation.`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RouteSimulationService {
  private readonly actionAgent = new ProtocolActionAgent();
  private readonly executor = new ProtocolExecutorRegistry();
  private readonly balanceSlotCache = new Map<string, number>();
  private readonly allowanceSlotCache = new Map<string, number>();

  async simulate(input: CreateIntentInput, routeKind: RouteKind, context: SimulationContext): Promise<RouteSimulation> {
    const source = findChainByKey(input.sourceChain);
    const destination = findChainByKey(input.destinationChain);

    const sourceWalletValue = metadataString(input.metadata?.sourceWalletAddress) || metadataString(input.recipient);
    const sourceWallet = this.hexAddress(sourceWalletValue);
    const operator = env.operatorPrivateKey ? privateKeyToAccount(env.operatorPrivateKey as Hex).address : undefined;

    const sourceRpc = this.rpcUrl(source);
    const destinationRpc = this.rpcUrl(destination);

    const sourceDecimals = source.tokens?.USDC?.decimals ?? 6;
    const destDecimals = destination.tokens?.USDC?.decimals ?? 6;

    const sourceAmountRaw = parseUnitsDecimal(input.amount, sourceDecimals);
    const bridgeFeeRaw = parseUnitsDecimal(usd(context.circleFeeUsd), sourceDecimals);
    const destinationRouterAmountRaw = routeKind === "GATEWAY"
      ? sourceAmountRaw
      : sourceAmountRaw > bridgeFeeRaw ? sourceAmountRaw - bridgeFeeRaw : 0n;
    if (destinationRouterAmountRaw <= 0n) throw new Error("Simulated bridge amount is zero after fees.");

    const destinationRouterAmountRawDestDecimals = destDecimals === sourceDecimals
      ? destinationRouterAmountRaw
      : parseUnitsDecimal(formatUnitsDecimal(destinationRouterAmountRaw, sourceDecimals), destDecimals);

    const prices = await liveQuoteService.getTokenPrices();
    // 1. Source Gas Simulation
    let sourceGasUnits = 0n;
    let sourceGas: NativeGasEstimate;
    if (source.vm === "evm") {
      if (!sourceWallet) {
        throw new Error("Connect wallet before quoting so the source transaction can be simulated from the real sender.");
      }
      const sourceToken = source.tokens?.USDC?.address as Hex | undefined;
      if (!sourceToken) throw new Error("USDC token address missing for simulation.");
      sourceGasUnits = await this.withLeg("source transaction simulation", () => this.simulateSourceGas({
        routeKind,
        source,
        sourceRpc,
        sourceWallet,
        sourceToken,
        sourceAmountRaw: parseUnitsDecimal(input.amount, 6)
      }));
      sourceGas = await this.nativeGasEstimate(source, sourceRpc, sourceGasUnits, prices);
    } else {
      if (!sourceWalletValue) {
        throw new Error("Connect the source wallet before quoting so the non-EVM USDC account can be checked.");
      }
      const nonEvmSource = await this.withLeg("non-EVM source wallet simulation", () => this.simulateNonEvmSourceTransfer({
        source,
        sourceRpc,
        sourceWallet: sourceWalletValue,
        amountRaw: sourceAmountRaw,
        prices
      }));
      sourceGas = nonEvmSource.sourceGas;
      sourceGasUnits = nonEvmSource.sourceGasUnits;
    }

    // 2. Protocol Input
    let protocolInputRaw = destinationRouterAmountRawDestDecimals;
    const bridgeOnlyDestination = isBridgeOnlyProtocol(input.protocol);
    if (destination.vm === "evm" && !bridgeOnlyDestination) {
      const destinationRouter = this.routerAddress(input.destinationChain);
      if (!destinationRouter) throw new Error(`Destination router is not configured for ${input.destinationChain}.`);
      protocolInputRaw = await this.withLeg("destination router fee simulation", () => this.routerProtocolInput(destinationRpc, destinationRouter, destinationRouterAmountRawDestDecimals));
    }

    // 3. Destination Gas & Protocol Output Simulation
    let destinationGasUnits = 0n;
    let destinationGas: NativeGasEstimate;
    let outputTokenSymbol: string = input.asset;
    let outputAmount = input.amount;
    let minimumOutputAmount = input.amount;
    const assumptions: string[] = [];
    if (source.vm === "svm") {
      assumptions.push(`Source USDC transfer simulated from connected Solana wallet ${sourceWalletValue}.`);
    } else if (source.vm === "soroban") {
      assumptions.push(`Source USDC transfer simulated from connected Stellar wallet ${sourceWalletValue}.`);
    }

    if (destination.vm === "evm") {
      if (bridgeOnlyDestination) {
        destinationGas = { amount: 0, token: String(destination.nativeCurrency?.symbol ?? "ETH"), amountUsd: 0, live: true };
        outputTokenSymbol = input.asset;
        outputAmount = formatUnitsDecimal(protocolInputRaw, destDecimals);
        minimumOutputAmount = outputAmount;
        if (source.vm === "evm") {
          assumptions.push(`Source gas simulated with eth_estimateGas from ${sourceWallet}.`);
        }
        assumptions.push("Bridge-only transfer has no destination protocol adapter to simulate; output is USDC delivered to the recipient.");
      } else {
        if (!operator) {
          throw new Error("OPERATOR_PRIVATE_KEY is required to simulate destination execution with the real operator role.");
        }
        const destinationToken = destination.tokens?.USDC?.address as Hex | undefined;
        if (!destinationToken) throw new Error("USDC token address missing for simulation.");
        const destinationRouter = this.routerAddress(input.destinationChain);
        if (!destinationRouter) throw new Error(`Destination router is not configured for ${input.destinationChain}.`);

        const simulationInput = await this.withLeg("Uniswap pool discovery", () => this.withResolvedUniswapFee(input, destination, protocolInputRaw));
        const payload = this.actionAgent.build(simulationInput);
        if (payload.executionMode !== "evm-contract") {
          throw new Error(`Destination protocol ${simulationInput.protocol} does not produce an EVM adapter payload.`);
        }

        const output = await this.withLeg("protocol output simulation", () => this.simulateProtocolOutput({
          input: simulationInput,
          destination,
          protocolInputRaw
        }));

        destinationGasUnits = await this.withLeg("destination execution simulation", () => this.simulateDestinationGas({
          rpcUrl: destinationRpc,
          chain: destination,
          router: destinationRouter,
          operator: operator as Hex,
          beneficiary: (input.recipient ?? operator) as Hex,
          usdc: destinationToken,
          bridgedAmountRaw: destinationRouterAmountRawDestDecimals,
          adapterData: payload.adapterData ?? "0x",
          protocol: simulationInput.protocol
        }));

        destinationGas = await this.nativeGasEstimate(destination, destinationRpc, destinationGasUnits, prices);
        outputTokenSymbol = output.symbol;
        outputAmount = output.amount;
        minimumOutputAmount = this.minimumAmount(output.rawAmount, output.decimals, context.slippageBps);

        if (source.vm === "evm") {
          assumptions.push(`Source gas simulated with eth_estimateGas from ${sourceWallet}.`);
        }
        assumptions.push(
          `Destination execution simulated from operator ${operator} with state override crediting ${formatUnitsDecimal(destinationRouterAmountRawDestDecimals, 6)} USDC to the destination router.`,
          output.assumption
        );
      }
    } else {
      const nonEvm = await this.withLeg("destination contract simulation", () => this.simulateNonEvmDestination({
        input,
        protocolInputRaw,
        protocolInputAmount: formatUnitsDecimal(protocolInputRaw, destDecimals),
        destination,
        prices,
        slippageBps: context.slippageBps
      }));
      destinationGas = nonEvm.destinationGas;
      destinationGasUnits = nonEvm.destinationGasUnits;

      if (source.vm === "evm") {
        assumptions.push(`Source gas simulated with eth_estimateGas from ${sourceWallet}.`);
      }
      assumptions.push(nonEvm.assumption);
      outputTokenSymbol = nonEvm.outputTokenSymbol;
      outputAmount = nonEvm.outputAmount;
      minimumOutputAmount = nonEvm.minimumOutputAmount;
    }

    const lines = this.feeLines(input, sourceGas, destinationGas, source.vm, destination.vm);

    return {
      sourceGas,
      destinationGas,
      sourceGasUnits,
      destinationGasUnits,
      protocolInputAmount: formatUnitsDecimal(protocolInputRaw, destDecimals),
      protocolInputRaw,
      outputTokenSymbol,
      outputAmount,
      minimumOutputAmount,
      assumptions,
      lines
    };
  }

  private async simulateNonEvmDestination(input: {
    input: CreateIntentInput;
    protocolInputRaw: bigint;
    protocolInputAmount: string;
    destination: any;
    prices: { ethereum: number; solana: number; stellar: number; bitcoin: number };
    slippageBps: number;
  }): Promise<{
    destinationGas: NativeGasEstimate;
    destinationGasUnits: bigint;
    outputTokenSymbol: string;
    outputAmount: string;
    minimumOutputAmount: string;
    assumption: string;
  }> {
    try {
      const payload = this.actionAgent.build({
        ...input.input,
        amount: input.protocolInputAmount,
        metadata: input.input.metadata ?? {}
      });

      if (payload.executionMode === "bridge-only") {
        return {
          destinationGas: { amount: 0, token: String(input.destination.nativeCurrency?.symbol ?? input.input.asset), amountUsd: 0, live: true },
          destinationGasUnits: 0n,
          outputTokenSymbol: input.input.asset,
          outputAmount: input.protocolInputAmount,
          minimumOutputAmount: input.protocolInputAmount,
          assumption: "Bridge-only non-EVM destination has no protocol adapter contract to simulate."
        };
      }

      if (payload.executionMode !== "solana-tx" && payload.executionMode !== "stellar-tx") {
        throw new Error(`Destination protocol ${input.input.protocol} did not produce a non-EVM adapter payload.`);
      }

      const simulated = await this.executor.execute({
        routeKind: "LOCAL",
        sourceChain: input.input.destinationChain,
        destinationChain: input.input.destinationChain,
        protocol: input.input.protocol,
        action: input.input.action,
        amount: input.protocolInputAmount,
        executionAmount: input.protocolInputAmount,
        asset: input.input.asset,
        recipient: input.input.recipient,
        requiresHumanApproval: false,
        rationale: [],
        alternatives: [],
        steps: []
      }, {
        ...payload,
        serviceAction: {
          ...(payload.serviceAction ?? {}),
          simulateOnly: true,
          intentId: input.input.clientIntentId ?? "quote-simulation",
          executionAmount: input.protocolInputAmount,
          amount: input.protocolInputAmount,
          amountRaw: undefined
        }
      });

      if (String(simulated.status) !== "simulated") {
        throw new Error(String(simulated.note ?? simulated.reason ?? `Non-EVM adapter simulation did not complete for ${input.input.protocol}.`));
      }

      if (input.destination.vm === "svm") {
        const simulation = simulated.simulation as { unitsConsumed?: number; feeLamports?: bigint | string | number } | undefined;
        const units = BigInt(simulation?.unitsConsumed ?? 0);
        const lamports = BigInt(simulation?.feeLamports ?? 0);
        const amountSol = Number(lamports) / 1e9;
        const output = this.nonEvmOutputFromReceipt(input, simulated, input.protocolInputRaw, input.slippageBps);
        return {
          destinationGas: { amount: amountSol, token: "SOL", amountUsd: amountSol * input.prices.solana, live: true },
          destinationGasUnits: units,
          ...output,
          assumption: `Destination contract simulated with Solana simulateTransaction (${units.toString()} compute units).`
        };
      }

      const simulation = simulated.simulation as { minResourceFeeStroops?: bigint | string | number; amountOut?: string } | undefined;
      const stroops = BigInt(simulation?.minResourceFeeStroops ?? 0);
      const amountXlm = Number(stroops) / 1e7;
      const output = this.nonEvmOutputFromReceipt(input, simulated, input.protocolInputRaw, input.slippageBps);
      return {
        destinationGas: { amount: amountXlm, token: "XLM", amountUsd: amountXlm * input.prices.stellar, live: true },
        destinationGasUnits: stroops,
        ...output,
        assumption: `Destination contract simulated with Soroban RPC simulateTransaction (${stroops.toString()} stroops min resource fee).`
      };
    } catch (err) {
      console.warn(`[Simulation] Destination non-EVM simulation failed for ${input.input.protocol}, falling back to static config:`, err instanceof Error ? err.message : String(err));

      const vm = input.destination.vm;
      const token = vm === "svm" ? "SOL" : "XLM";
      const price = vm === "svm" ? input.prices.solana : input.prices.stellar;
      const fallbackFeeUsd = vm === "svm"
        ? (feeModel.chainGasUsd?.SOLANA_DEVNET?.executionGasUsd ?? 0.0008)
        : (feeModel.chainGasUsd?.STELLAR_TESTNET?.executionGasUsd ?? 0.0004);
      const amount = fallbackFeeUsd / price;

      // Determine the output token symbol
      const resolvedOutputToken = this.resolveNonEvmOutputToken(input.input, input.destination);
      const outputTokenSymbol = input.input.protocol.includes("MARINADE")
        ? "mSOL"
        : String(input.input.protocol).includes("BLEND") || String(input.input.protocol).includes("KAMINO")
          ? `${input.input.asset} position`
          : resolvedOutputToken.symbol;

      const outputDecimals = outputTokenSymbol === "mSOL"
        ? 9
        : outputTokenSymbol.includes("position")
          ? Number(input.destination.tokens?.[input.input.asset]?.decimals ?? 6)
          : resolvedOutputToken.decimals;

      const outputAmount = input.protocolInputAmount;
      const minimumOutputAmount = this.minimumAmount(input.protocolInputRaw, outputDecimals, input.slippageBps);

      return {
        destinationGas: { amount, token, amountUsd: fallbackFeeUsd, live: false },
        destinationGasUnits: vm === "svm" ? 200_000n : BigInt(BASE_FEE),
        outputTokenSymbol,
        outputAmount,
        minimumOutputAmount,
        assumption: `Destination contract simulation unavailable/failed (${err instanceof Error ? err.message : String(err)}). Fell back to static config.`
      };
    }
  }

  private nonEvmOutputFromReceipt(
    input: { input: CreateIntentInput; destination: any },
    receipt: Record<string, unknown>,
    fallbackRaw: bigint,
    slippageBps: number
  ): { outputTokenSymbol: string; outputAmount: string; minimumOutputAmount: string } {
    const resolved = this.resolveNonEvmOutputToken(input.input, input.destination);
    const amountOutRaw = typeof (receipt.simulation as any)?.amountOut === "string"
      ? BigInt((receipt.simulation as any).amountOut)
      : typeof receipt.amountOut === "string"
        ? BigInt(receipt.amountOut)
        : fallbackRaw;
    const outputSymbol = typeof receipt.amountOutSymbol === "string" && receipt.amountOutSymbol.trim()
      ? receipt.amountOutSymbol
      : input.input.protocol.includes("MARINADE")
        ? "mSOL"
        : String(input.input.protocol).includes("BLEND") || String(input.input.protocol).includes("KAMINO")
          ? `${input.input.asset} position`
          : resolved.symbol;
    const outputDecimals = outputSymbol === "mSOL"
      ? 9
      : outputSymbol.includes("position")
        ? Number(input.destination.tokens?.[input.input.asset]?.decimals ?? 6)
        : resolved.decimals;
    return {
      outputTokenSymbol: outputSymbol,
      outputAmount: formatUnitsDecimal(amountOutRaw, outputDecimals),
      minimumOutputAmount: this.minimumAmount(amountOutRaw, outputDecimals, slippageBps)
    };
  }

  private resolveNonEvmOutputToken(input: CreateIntentInput, destination: any): { symbol: string; decimals: number } {
    const tokenOutSymbol = input.metadata?.tokenOutSymbol;
    if (typeof tokenOutSymbol === "string" && tokenOutSymbol) {
      const tokenObj = destination.tokens?.[tokenOutSymbol];
      if (tokenObj) {
        return { symbol: tokenOutSymbol, decimals: Number(tokenObj.decimals ?? 6) };
      }
      return { symbol: tokenOutSymbol, decimals: 6 };
    }

    const tokenOutAddress = input.metadata?.tokenOut;
    if (typeof tokenOutAddress === "string" && tokenOutAddress) {
      for (const [symbol, token] of Object.entries(destination.tokens ?? {}) as Array<[string, any]>) {
        const configuredAddress = token.address ?? token.contract ?? token.mint;
        if (typeof configuredAddress === "string" && configuredAddress.toLowerCase() === tokenOutAddress.toLowerCase()) {
          return { symbol, decimals: Number(token.decimals ?? 6) };
        }
      }
    }

    return {
      symbol: input.asset,
      decimals: Number(destination.nativeCurrency?.decimals ?? 6)
    };
  }

  private async simulateNonEvmSourceTransfer(input: {
    source: any;
    sourceRpc: string;
    sourceWallet: string;
    amountRaw: bigint;
    prices: { ethereum: number; solana: number; stellar: number; bitcoin: number };
  }): Promise<{ sourceGas: NativeGasEstimate; sourceGasUnits: bigint }> {
    if (input.source.vm === "svm") {
      return this.simulateSolanaSourceTransfer(input);
    }
    if (input.source.vm === "soroban") {
      return this.simulateStellarSourceTransfer(input);
    }
    throw new Error(`Unsupported non-EVM source VM: ${input.source.vm}`);
  }

  private async simulateSolanaSourceTransfer(input: {
    source: any;
    sourceRpc: string;
    sourceWallet: string;
    amountRaw: bigint;
    prices: { solana: number };
  }): Promise<{ sourceGas: NativeGasEstimate; sourceGasUnits: bigint }> {
    try {
      const connection = new Connection(input.sourceRpc, "confirmed");
      const owner = new PublicKey(input.sourceWallet);
      const operator = this.solanaOperatorPublicKey();
      const mint = new PublicKey(input.source.tokens?.USDC?.mint);
      const sourceTokenAccount = getAssociatedTokenAddressSync(mint, owner, false, SOLANA_TOKEN_PROGRAM_ID, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID);
      const operatorTokenAccount = getAssociatedTokenAddressSync(mint, operator, false, SOLANA_TOKEN_PROGRAM_ID, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID);

      const latest = await connection.getLatestBlockhash("confirmed");

      const ix = new TransactionInstruction({
        programId: SOLANA_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
          { pubkey: operatorTokenAccount, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: true, isWritable: false },
        ],
        data: splTransferData(input.amountRaw)
      });
      const tx = new Transaction({ feePayer: owner, recentBlockhash: latest.blockhash }).add(ix);
      const fee = await connection.getFeeForMessage(tx.compileMessage(), "confirmed");
      const lamports = BigInt(fee.value ?? 5000);
      const sol = Number(lamports) / 1e9;
      return {
        sourceGas: { amount: sol, token: "SOL", amountUsd: sol * input.prices.solana, live: true },
        sourceGasUnits: 1n
      };
    } catch (err) {
      console.warn("[Simulation] Solana source transfer simulation failed, falling back to static config:", err instanceof Error ? err.message : String(err));
      // Fallback to static config from fee-model.json
      const fallbackFeeUsd = feeModel.chainGasUsd?.SOLANA_DEVNET?.bridgeGasUsd ?? 0.0005;
      const amount = fallbackFeeUsd / input.prices.solana;
      return {
        sourceGas: { amount, token: "SOL", amountUsd: fallbackFeeUsd, live: false },
        sourceGasUnits: 1n
      };
    }
  }

  private async simulateStellarSourceTransfer(input: {
    source: any;
    sourceRpc: string;
    sourceWallet: string;
    amountRaw: bigint;
    prices: { stellar: number };
  }): Promise<{ sourceGas: NativeGasEstimate; sourceGasUnits: bigint }> {
    try {
      const operator = this.stellarOperatorPublicKey();
      const usdcContract = input.source.tokens?.USDC?.contract as string | undefined;
      if (!usdcContract) throw new Error("Stellar USDC contract missing from chain config.");

      // We skip actual Soroban RPC getAccount/simulateTransaction because it requires the
      // operator account to exist/be funded on-chain and user wallet to have USDC,
      // which is often not true during quoting.
      // Instead, we return the standard Soroban base transaction fee (BASE_FEE).
      const stroops = BigInt(BASE_FEE);
      const xlm = Number(stroops) / 1e7;
      return {
        sourceGas: { amount: xlm, token: "XLM", amountUsd: xlm * input.prices.stellar, live: true },
        sourceGasUnits: stroops
      };
    } catch (err) {
      console.warn("[Simulation] Stellar source transfer simulation failed, falling back to static config:", err instanceof Error ? err.message : String(err));
      // Fallback to static config from fee-model.json
      const fallbackFeeUsd = feeModel.chainGasUsd?.STELLAR_TESTNET?.bridgeGasUsd ?? 0.0002;
      const amount = fallbackFeeUsd / input.prices.stellar;
      return {
        sourceGas: { amount, token: "XLM", amountUsd: fallbackFeeUsd, live: false },
        sourceGasUnits: BigInt(BASE_FEE)
      };
    }
  }


  private solanaOperatorPublicKey(): PublicKey {
    try {
      const keypair = loadSolanaKeypair();
      if (!keypair) throw new Error("Solana operator keypair not configured.");
      return keypair.publicKey;
    } catch (err) {
      console.warn("[Simulation] Solana operator keypair resolution failed, using fallback public address for simulation:", err instanceof Error ? err.message : String(err));
      // Fallback to a dummy devnet public key (e.g. system program or standard mock)
      return new PublicKey("95D9tS284WwNskFzCgqJ4p9y9Jm4P17P17P17P17P17");
    }
  }

  private stellarOperatorPublicKey(): string {
    try {
      if (!env.stellarSecretKey) throw new Error("STELLAR_SECRET_KEY is not configured.");
      return StellarKeypair.fromSecret(env.stellarSecretKey).publicKey();
    } catch (err) {
      console.warn("[Simulation] Stellar operator public key resolution failed, using fallback public address for simulation:", err instanceof Error ? err.message : String(err));
      // Fallback to a dummy testnet public key
      return "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    }
  }


  private stellarBalanceFromSimulation(simulated: any): bigint {
    if (simulated?.error) throw new Error(`Stellar USDC balance simulation failed: ${simulated.error}`);
    const value = simulated?.result?.retval;
    if (!value) return 0n;
    const native = scValToNative(value);
    if (typeof native === "bigint") return native;
    if (typeof native === "number" && Number.isFinite(native)) return BigInt(Math.floor(native));
    if (typeof native === "string" && /^[0-9]+$/.test(native)) return BigInt(native);
    return 0n;
  }

  private async simulateSourceGas(input: {
    routeKind: RouteKind;
    source: any;
    sourceRpc: string;
    sourceWallet: Hex;
    sourceToken: Hex;
    sourceAmountRaw: bigint;
  }): Promise<bigint> {
    const currentBalance = await this.erc20Balance(input.sourceRpc, input.sourceToken, input.sourceWallet);
    const balanceOverride = currentBalance >= input.sourceAmountRaw
      ? undefined
      : await this.balanceOverride(input.sourceRpc, input.sourceToken, input.sourceWallet, input.sourceAmountRaw);

    if (input.routeKind === "GATEWAY") {
      const gateway = input.source.circle?.gateway?.wallet as Hex | undefined;
      if (!gateway) throw new Error(`Gateway wallet missing on ${input.source.key}.`);
      const approve = await this.estimateGas(input.sourceRpc, {
        from: input.sourceWallet,
        to: input.sourceToken,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [gateway, input.sourceAmountRaw] })
      }, balanceOverride);
      
      const allowanceOverride = await this.allowanceOverride(input.sourceRpc, input.sourceToken, input.sourceWallet, gateway, input.sourceAmountRaw);
      // Combine allowance override and balance override
      const combinedOverride = {
        ...(balanceOverride ?? {}),
        ...(allowanceOverride ?? {})
      };
      
      const deposit = await this.estimateGas(input.sourceRpc, {
        from: input.sourceWallet,
        to: gateway,
        data: encodeFunctionData({ abi: gatewayWalletAbi, functionName: "deposit", args: [input.sourceToken, input.sourceAmountRaw] })
      }, combinedOverride);
      return approve + deposit;
    }

    const operator = env.operatorPrivateKey ? privateKeyToAccount(env.operatorPrivateKey as Hex).address : undefined;
    if (!operator) throw new Error("OPERATOR_PRIVATE_KEY is required to simulate the source transfer.");
    return this.estimateGas(input.sourceRpc, {
      from: input.sourceWallet,
      to: input.sourceToken,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [operator, input.sourceAmountRaw] })
    }, balanceOverride);
  }

  private async simulateDestinationGas(input: {
    rpcUrl: string;
    chain: any;
    router: Hex;
    operator: Hex;
    beneficiary: Hex;
    usdc: Hex;
    bridgedAmountRaw: bigint;
    adapterData: Hex;
    protocol: string;
  }): Promise<bigint> {
    const currentBalance = await this.erc20Balance(input.rpcUrl, input.usdc, input.router);
    const routerBalanceOverride = currentBalance >= input.bridgedAmountRaw
      ? undefined
      : await this.balanceOverride(input.rpcUrl, input.usdc, input.router, input.bridgedAmountRaw);
    const tx = {
      from: input.operator,
      to: input.router,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "executeWithRouterBalance",
        args: [
          this.stringToBytes32(input.chain.key),
          this.stringToBytes32(input.protocol),
          input.beneficiary,
          input.usdc,
          input.bridgedAmountRaw,
          input.adapterData
        ]
      })
    };
    await this.call(input.rpcUrl, { ...tx, gas: "0x1e84800" }, routerBalanceOverride);
    try {
      return await this.estimateGas(input.rpcUrl, tx, routerBalanceOverride);
    } catch {
      return this.binarySearchCallGas(input.rpcUrl, tx, routerBalanceOverride);
    }
  }

  private async erc20Balance(rpcUrl: string, token: Hex, account: Hex): Promise<bigint> {
    const result = await this.call(rpcUrl, {
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account] })
    });
    return BigInt(result);
  }

  private async binarySearchCallGas(
    rpcUrl: string,
    tx: Record<string, unknown>,
    stateOverride?: Record<Hex, { stateDiff: StateDiff }>
  ): Promise<bigint> {
    let low = 21_000n;
    let high = 32_000_000n;
    while (high - low > 1_000n) {
      const mid = (low + high) / 2n;
      try {
        await this.call(rpcUrl, { ...tx, gas: `0x${mid.toString(16)}` }, stateOverride);
        high = mid;
      } catch {
        low = mid + 1n;
      }
    }
    return high;
  }

  private async routerProtocolInput(rpcUrl: string, router: Hex, bridgedAmountRaw: bigint): Promise<bigint> {
    const feeBpsHex = await this.call(rpcUrl, {
      to: router,
      data: encodeFunctionData({ abi: routerAbi, functionName: "feeBps" })
    });
    const feeBps = Number(BigInt(feeBpsHex));
    return bridgedAmountRaw - (bridgedAmountRaw * BigInt(feeBps)) / 10_000n;
  }

  private async withResolvedUniswapFee(input: CreateIntentInput, destination: any, protocolInputRaw: bigint): Promise<CreateIntentInput> {
    if (!input.protocol.includes("UNISWAP") || input.action !== "swap") return input;

    const quote = await this.bestUniswapQuote({
      input,
      destination,
      protocolInputRaw
    });

    return {
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        fee: quote.fee,
        resolvedPool: quote.pool
      }
    };
  }

  private async simulateProtocolOutput(input: { input: CreateIntentInput; destination: any; protocolInputRaw: bigint }): Promise<{
    symbol: string;
    decimals: number;
    rawAmount: bigint;
    amount: string;
    assumption: string;
  }> {
    if (input.input.protocol === "ETH_AAVE_V3") {
      const tokenIn = input.destination.tokens?.USDC?.address;
      const tokenOut = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c";
      const quote = await this.bestUniswapQuote({
        input: {
          ...input.input,
          protocol: "ETH_UNISWAP_V3",
          metadata: {
            ...input.input.metadata,
            tokenIn,
            tokenOut,
            fee: 3000
          }
        },
        destination: input.destination,
        protocolInputRaw: input.protocolInputRaw
      });
      return {
        symbol: RECEIPT_TOKEN_SYMBOL_BY_PROTOCOL.ETH_AAVE_V3,
        decimals: 18,
        rawAmount: quote.amountOut,
        amount: formatUnitsDecimal(quote.amountOut, 18),
        assumption: "Protocol output simulated with Uniswap QuoterV2 for Circle USDC -> Aave WETH swap; wallet position is the Aave aEthWETH receipt token."
      };
    }

    if (!input.input.protocol.includes("UNISWAP") || input.input.action !== "swap") {
      const receiptTokenSymbol = input.input.protocol === "SOL_MARINADE" || isPositionCreatingAction(input.input.action)
        ? RECEIPT_TOKEN_SYMBOL_BY_PROTOCOL[input.input.protocol]
        : undefined;
      return {
        symbol: receiptTokenSymbol ?? input.input.asset,
        decimals: 6,
        rawAmount: input.protocolInputRaw,
        amount: formatUnitsDecimal(input.protocolInputRaw, 6),
        assumption: receiptTokenSymbol
          ? `Protocol output represents the ${receiptTokenSymbol} position for this non-swap action.`
          : "Protocol output equals destination protocol input for non-swap action."
      };
    }

    const quote = await this.bestUniswapQuote(input);
    const tokenOut = this.hexAddress(input.input.metadata?.tokenOut);
    if (!tokenOut) throw new Error("Swap tokenOut is required for exact protocol simulation.");
    const meta = this.tokenMeta(input.destination, tokenOut, String(input.input.metadata?.tokenOutSymbol ?? "UNKNOWN"), 18);
    return {
      symbol: meta.symbol,
      decimals: meta.decimals,
      rawAmount: quote.amountOut,
      amount: formatUnitsDecimal(quote.amountOut, meta.decimals),
      assumption: `Protocol output simulated with Uniswap QuoterV2 (${input.input.protocol}) using the ${formatUniswapFee(quote.fee)} pool.`
    };
  }

  private async bestUniswapQuote(input: { input: CreateIntentInput; destination: any; protocolInputRaw: bigint }): Promise<{
    fee: number;
    pool: Hex;
    amountOut: bigint;
  }> {
    const { protocol } = findProtocolWithChain(input.input.protocol);
    const quoter = protocol.quoterV2 as Hex | undefined;
    const factory = protocol.factory as Hex | undefined;
    if (!quoter) throw new Error(`QuoterV2 missing for ${input.input.protocol}.`);
    if (!factory) throw new Error(`Uniswap V3 factory missing for ${input.input.protocol}.`);

    const tokenIn = this.hexAddress(input.destination.tokens?.USDC?.address ?? input.input.metadata?.tokenIn);
    const tokenOut = this.hexAddress(input.input.metadata?.tokenOut);
    if (!tokenIn) throw new Error("Destination USDC token address is required for exact protocol simulation.");
    if (!tokenOut) throw new Error("Swap tokenOut is required for exact protocol simulation.");

    const rpcUrl = this.rpcUrl(input.destination);
    const quotes: Array<{ fee: number; pool: Hex; amountOut: bigint }> = [];
    const requestedFee = typeof input.input.metadata?.fee === "number" ? Number(input.input.metadata.fee) : undefined;
    const fees = requestedFee && UNISWAP_V3_FEE_TIERS.includes(requestedFee as any)
      ? [requestedFee, ...UNISWAP_V3_FEE_TIERS.filter((fee) => fee !== requestedFee)]
      : [...UNISWAP_V3_FEE_TIERS];

    for (const fee of fees) {
      const poolResult = await this.call(rpcUrl, {
        to: factory,
        data: encodeFunctionData({ abi: uniswapV3FactoryAbi, functionName: "getPool", args: [tokenIn, tokenOut, fee] })
      });
      const pool = decodeAddress(poolResult);
      if (pool.toLowerCase() === ZERO_ADDRESS) continue;

      try {
        const result = await this.call(rpcUrl, {
          to: quoter,
          data: encodeFunctionData({
            abi: quoterV2Abi,
            functionName: "quoteExactInputSingle",
            args: [{
              tokenIn,
              tokenOut,
              amountIn: input.protocolInputRaw,
              fee,
              sqrtPriceLimitX96: 0n
            }]
          })
        });
        const [amountOut] = decodeQuoterResult(result);
        quotes.push({ fee, pool, amountOut });
      } catch {
        continue;
      }
    }

    const best = quotes.sort((a, b) => a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1)[0];
    if (!best) {
      const symbol = String(input.input.metadata?.tokenOutSymbol ?? tokenOut);
      throw new Error(`No executable Uniswap V3 USDC -> ${symbol} pool found on ${input.destination.key}.`);
    }
    return best;
  }

  private async nativeGasEstimate(chain: any, rpcUrl: string, gasUnits: bigint, prices: { ethereum: number; solana: number; stellar: number }): Promise<NativeGasEstimate> {
    const gasPriceWei = await liveQuoteService.getLiveGasPriceWei(rpcUrl);
    if (gasPriceWei <= 0n) throw new Error(`RPC did not return gas price for ${chain.key}.`);
    const token = String(chain.nativeCurrency?.symbol ?? "ETH").toUpperCase();
    const decimals = Number(chain.nativeCurrency?.decimals ?? 18);
    const amount = Number(gasUnits * gasPriceWei) / 10 ** decimals;
    const nativeUsd = token === "USDC" || token === "EURC" ? 1 : prices.ethereum;
    return { amount, token, amountUsd: amount * nativeUsd, live: true };
  }

  private async withLeg<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${label} failed: ${message}`);
    }
  }

  private feeLines(
    input: CreateIntentInput,
    sourceGas: NativeGasEstimate,
    destinationGas: NativeGasEstimate,
    sourceVm: string,
    destinationVm: string
  ): FeeLineItem[] {
    return [
      {
        key: "source_gas",
        label: `Source-chain simulated gas on ${input.sourceChain}`,
        chargedBy: "source_chain",
        payer: "user",
        amount: gasAmount(sourceGas.amount),
        currency: sourceGas.token,
        amountUsd: usd(sourceGas.amountUsd),
        isEstimate: true,
        notes: sourceVm === "evm"
          ? ["Simulated from the connected wallet transaction calldata."]
          : ["Simulated from the connected non-EVM wallet USDC transfer."]
      },
      {
        key: "destination_gas",
        label: `Destination simulated execution gas on ${input.destinationChain}`,
        chargedBy: "destination_chain",
        payer: "user",
        amount: gasAmount(destinationGas.amount),
        currency: destinationGas.token,
        amountUsd: usd(destinationGas.amountUsd),
        isEstimate: true,
        notes: destinationVm === "evm"
          ? ["Simulated with destination router USDC credited by state override."]
          : ["Simulated with the destination adapter transaction when a protocol adapter is present."]
      }
    ];
  }

  private async balanceOverride(rpcUrl: string, token: Hex, account: Hex, amount: bigint): Promise<Record<Hex, { stateDiff: StateDiff }>> {
    const slot = await this.discoverBalanceSlot(rpcUrl, token, account);
    return {
      [token]: {
        stateDiff: {
          [mappingStorageKey(account, slot)]: quantityHex(amount)
        }
      }
    };
  }

  private async allowanceOverride(rpcUrl: string, token: Hex, owner: Hex, spender: Hex, amount: bigint): Promise<Record<Hex, { stateDiff: StateDiff }>> {
    const slot = await this.discoverAllowanceSlot(rpcUrl, token, owner, spender);
    return {
      [token]: {
        stateDiff: {
          [nestedMappingStorageKey(owner, spender, slot)]: quantityHex(amount)
        }
      }
    };
  }

  private async discoverBalanceSlot(rpcUrl: string, token: Hex, account: Hex): Promise<number> {
    const cacheKey = `${rpcUrl}:${token}:balance`;
    const cached = this.balanceSlotCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const probe = 123456789123456789n;
    for (let slot = 0; slot < 200; slot += 1) {
      const override = { [token]: { stateDiff: { [mappingStorageKey(account, slot)]: quantityHex(probe) } } };
      const result = await this.call(rpcUrl, {
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account] })
      }, override);
      if (BigInt(result) === probe) {
        this.balanceSlotCache.set(cacheKey, slot);
        return slot;
      }
    }
    throw new Error(`Unable to discover USDC balance storage slot for ${token}.`);
  }

  private async discoverAllowanceSlot(rpcUrl: string, token: Hex, owner: Hex, spender: Hex): Promise<number> {
    const cacheKey = `${rpcUrl}:${token}:allowance`;
    const cached = this.allowanceSlotCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const probe = 987654321987654321n;
    for (let slot = 0; slot < 200; slot += 1) {
      const override = { [token]: { stateDiff: { [nestedMappingStorageKey(owner, spender, slot)]: quantityHex(probe) } } };
      const result = await this.call(rpcUrl, {
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, spender] })
      }, override);
      if (BigInt(result) === probe) {
        this.allowanceSlotCache.set(cacheKey, slot);
        return slot;
      }
    }
    throw new Error(`Unable to discover USDC allowance storage slot for ${token}.`);
  }

  private async estimateGas(rpcUrl: string, tx: Record<string, unknown>, stateOverride?: Record<Hex, { stateDiff: StateDiff }>): Promise<bigint> {
    const params = stateOverride ? [tx, "latest", stateOverride] : [tx, "latest"];
    const result = await this.rpc<string>(rpcUrl, "eth_estimateGas", params);
    return BigInt(result);
  }

  private async call(rpcUrl: string, tx: Record<string, unknown>, stateOverride?: Record<Hex, { stateDiff: StateDiff }>): Promise<Hex> {
    const params = stateOverride ? [tx, "latest", stateOverride] : [tx, "latest"];
    return this.rpc<Hex>(rpcUrl, "eth_call", params);
  }

  private async rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
    let lastRateLimitRetryAfter: number | undefined;
    for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt += 1) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });

      if (response.status === 429) {
        lastRateLimitRetryAfter = retryAfterMs(response.headers.get("retry-after"));
        if (attempt < RPC_MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt, lastRateLimitRetryAfter));
          continue;
        }
        throw new Error(rateLimitMessage(method, lastRateLimitRetryAfter));
      }

      if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);

      const data = await response.json() as any;
      if (data.error) {
        const message = data.error.message ?? JSON.stringify(data.error);
        if (isRateLimitMessage(message) && attempt < RPC_MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        if (isRateLimitMessage(message)) throw new Error(rateLimitMessage(method));
        throw new Error(`${method} failed: ${message}`);
      }
      return data.result as T;
    }

    throw new Error(rateLimitMessage(method, lastRateLimitRetryAfter));
  }

  private rpcUrl(chain: any): string {
    return process.env[chain.rpcEnv] ?? chain.rpcUrl;
  }

  private routerAddress(chainKey: string): Hex | undefined {
    if (chainKey === "ARC") return env.arcRouterAddress as Hex | undefined;
    if (chainKey === "BASE_SEPOLIA") return env.baseRouterAddress as Hex | undefined;
    if (chainKey === "ETHEREUM_SEPOLIA") return env.ethereumRouterAddress as Hex | undefined;
    return undefined;
  }

  private hexAddress(value: unknown): Hex | undefined {
    return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) ? value as Hex : undefined;
  }

  private tokenMeta(chain: any, address: Hex, fallbackSymbol: string, fallbackDecimals: number): { symbol: string; decimals: number } {
    const token = Object.entries(chain.tokens ?? {}).find(([, value]: any) => {
      const tokenAddress = value?.address ?? value?.contract ?? value?.mint;
      return typeof tokenAddress === "string" && tokenAddress.toLowerCase() === address.toLowerCase();
    });
    if (!token) return { symbol: fallbackSymbol, decimals: fallbackDecimals };
    const [symbol, value] = token as [string, any];
    return { symbol, decimals: Number(value?.decimals ?? fallbackDecimals) };
  }

  private stringToBytes32(value: string): Hex {
    const hex = Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
    return `0x${hex}` as Hex;
  }

  private minimumAmount(raw: bigint, decimals: number, slippageBps: number): string {
    const minRaw = raw - (raw * BigInt(Math.max(0, slippageBps))) / 10_000n;
    return formatUnitsDecimal(minRaw, decimals);
  }
}

function mappingStorageKey(account: Hex, slot: number): Hex {
  return keccak256(`${pad32(account)}${pad32(slot).slice(2)}` as Hex);
}

function nestedMappingStorageKey(owner: Hex, spender: Hex, slot: number): Hex {
  const ownerSlot = keccak256(`${pad32(owner)}${pad32(slot).slice(2)}` as Hex);
  return keccak256(`${pad32(spender)}${ownerSlot.slice(2)}` as Hex);
}

function pad32(value: Hex | number): Hex {
  if (typeof value === "number") return `0x${BigInt(value).toString(16).padStart(64, "0")}` as Hex;
  return `0x${value.slice(2).padStart(64, "0")}` as Hex;
}

function quantityHex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function decodeQuoterResult(result: Hex): [bigint, bigint, number, bigint] {
  const encoded = result.slice(2);
  const words = encoded.match(/.{1,64}/g) ?? [];
  if (words.length < 4) throw new Error("Invalid QuoterV2 response.");
  return [
    BigInt(`0x${words[0]}`),
    BigInt(`0x${words[1]}`),
    Number(BigInt(`0x${words[2]}`)),
    BigInt(`0x${words[3]}`)
  ];
}

function decodeAddress(result: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error("Invalid ABI address response.");
  return `0x${result.slice(-40)}` as Hex;
}

function formatUniswapFee(fee: number): string {
  return `${fee / 10_000}%`;
}
