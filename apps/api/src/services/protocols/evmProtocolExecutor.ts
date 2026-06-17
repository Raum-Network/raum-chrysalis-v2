import { createWalletClient, createPublicClient, http, custom, parseAbi, parseEventLogs, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, findChainByKey } from "../../config/index.js";
import { ProtocolActionPayload } from "../../agents/ProtocolActionAgent.js";
import { RoutePlan } from "../../types.js";
import { formatUnitsDecimal } from "../../utils/amounts.js";

const routerAbi = parseAbi([
  "function routeLocal(bytes32 destinationChainKey, bytes32 protocolKey, address tokenIn, uint256 amountIn, address refundAddress, bytes actionData) payable returns (bytes32)",
  "function executeWithRouterBalance(bytes32 destinationChainKey, bytes32 protocolKey, address beneficiary, address tokenIn, uint256 amountIn, bytes actionData) payable returns (bytes32)",
  "event IntentCreated(bytes32 indexed intentId, address indexed initiator, bytes32 indexed destinationChainKey, bytes32 protocolKey, address tokenIn, uint256 amountIn)",
  "event IntentExecuted(bytes32 indexed intentId, bytes32 indexed adapterKey, address tokenOut, uint256 amountOut, bytes metadata)"
]);

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
]);

export class EvmProtocolExecutor {
  async execute(plan: RoutePlan, payload: ProtocolActionPayload): Promise<Record<string, unknown>> {
    if (payload.executionMode !== "evm-contract") return { skipped: true, reason: "Not an EVM payload." };
    if (env.demoMode || !env.operatorPrivateKey) {
      return {
        status: "mocked",
        txHash: `0xproto_${Date.now().toString(16)}`,
        plan,
        payload,
        note: "DEMO_MODE enabled or missing OPERATOR_PRIVATE_KEY."
      };
    }

    const chain = findChainByKey(plan.destinationChain);
    const rpc = process.env[chain.rpcEnv] ?? chain.rpcUrl;
    const account = privateKeyToAccount(env.operatorPrivateKey as Hex);
    const viemChain = {
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency ?? { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } }
    };
    const wallet = createWalletClient({ account, chain: viemChain, transport: http(rpc) });
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const routerAddress = plan.destinationChain === "ARC" ? env.arcRouterAddress : plan.destinationChain === "BASE_SEPOLIA" ? env.baseRouterAddress : plan.destinationChain === "ETHEREUM_SEPOLIA" ? env.ethereumRouterAddress : "";
    if (!routerAddress) {
      return {
        status: "not_deployed",
        chain: plan.destinationChain,
        protocol: plan.protocol,
        note: `Router contract not yet deployed on ${plan.destinationChain}. Set ${plan.destinationChain === "ETHEREUM_SEPOLIA" ? "ETHEREUM_ROUTER_ADDRESS" : "ARC_ROUTER_ADDRESS or BASE_ROUTER_ADDRESS"} in .env after deploying the router. Fee estimation is still accurate — only on-chain execution is gated.`
      };
    }

    // beneficiary = user's wallet (from intent recipient). Falls back to operator only if unset.
    const beneficiary = (plan.recipient ?? account.address) as Hex;

    const tokenAddress = chain.tokens.USDC.address as Hex;
    const requestedAmount = BigInt(Math.floor(Number(plan.executionAmount ?? plan.amount) * 1_000_000));

    // If LOCAL route, pre-fund the router contract from the Operator wallet
    if (plan.routeKind === "LOCAL") {
      const transferAmount = requestedAmount;
      
      const opBalance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address]
      });
      if (opBalance < transferAmount) {
        throw new Error(`Operator has insufficient USDC balance for local execution. Have ${Number(opBalance) / 1e6}, need ${plan.amount}`);
      }
      
      console.log(`[ProtocolExecutor] LOCAL route: transferring ${plan.amount} USDC from Operator to Router...`);
      const transferTxHash = await wallet.writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [routerAddress as Hex, transferAmount]
      });
      await publicClient.waitForTransactionReceipt({ hash: transferTxHash });
      console.log(`[ProtocolExecutor] Transfer done: ${transferTxHash}`);
    }

    const routerBalance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [routerAddress as Hex]
    });
    const executionAmount = requestedAmount;
    if (routerBalance < executionAmount) {
      throw new Error(`Destination router has insufficient USDC for this intent. Router balance is ${formatUnitsDecimal(routerBalance, 6)} USDC; need ${formatUnitsDecimal(executionAmount, 6)} USDC.`);
    }

    const hash = await wallet.writeContract({
      address: routerAddress as Hex,
      abi: routerAbi,
      functionName: "executeWithRouterBalance",
      args: [
        stringToBytes32(plan.destinationChain),
        stringToBytes32(plan.protocol),
        beneficiary,
        tokenAddress,
        executionAmount,
        payload.adapterData ?? "0x"
      ]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const intentCreated = parseLastEvent(receipt.logs, "IntentCreated");
    const intentExecuted = parseLastEvent(receipt.logs, "IntentExecuted");
    const adapterAmount = BigInt(String(intentCreated?.args?.amountIn ?? executionAmount));
    const eventTokenOut = (intentExecuted?.args?.tokenOut ?? tokenAddress) as Hex;
    const tokenOut = (eventTokenOut === "0x0000000000000000000000000000000000000000"
      ? payload.serviceAction?.tokenOut ?? tokenAddress
      : eventTokenOut) as Hex;
    const amountOut = BigInt(String(intentExecuted?.args?.amountOut ?? adapterAmount));
    const tokenInMeta = tokenMeta(chain, tokenAddress, "USDC", 6);
    const tokenOutMeta = tokenMeta(chain, tokenOut, String(payload.serviceAction?.tokenOutSymbol ?? "UNKNOWN"), tokenInMeta.decimals);
    const receiptToken = receiptTokenMeta(plan.protocol, plan.action, tokenOutMeta);

    return {
      status: "submitted",
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      beneficiary,
      routerIntentId: String(intentExecuted?.args?.intentId ?? intentCreated?.args?.intentId ?? ""),
      tokenIn: tokenAddress,
      tokenInSymbol: tokenInMeta.symbol,
      tokenInDecimals: tokenInMeta.decimals,
      tokenOut,
      tokenOutSymbol: tokenOutMeta.symbol,
      tokenOutDecimals: tokenOutMeta.decimals,
      suppliedTokenSymbol: tokenOutMeta.symbol,
      receiptTokenSymbol: receiptToken.symbol,
      receiptTokenDecimals: receiptToken.decimals,
      requestedAmountUsdc: plan.amount,
      bridgeAmountReceivedUsdc: plan.executionAmount ?? plan.amount,
      executedAmount: adapterAmount.toString(),
      executedAmountUsdc: formatUnitsDecimal(adapterAmount, tokenInMeta.decimals),
      amountOut: amountOut.toString(),
      amountOutFormatted: formatUnitsDecimal(amountOut, receiptToken.decimals),
      amountOutSymbol: receiptToken.symbol
    };
  }
}

function parseLastEvent(logs: any[], eventName: "IntentCreated" | "IntentExecuted"): any | undefined {
  const parsed = parseEventLogs({ abi: routerAbi, logs, eventName, strict: false });
  return parsed.at(-1);
}

function tokenMeta(chain: any, address: Hex, fallbackSymbol: string, fallbackDecimals: number): { symbol: string; decimals: number } {
  const token = Object.entries(chain.tokens ?? {}).find(([, value]: any) => {
    const tokenAddress = value?.address ?? value?.contract ?? value?.mint;
    return typeof tokenAddress === "string" && tokenAddress.toLowerCase() === address.toLowerCase();
  });
  if (!token) return { symbol: fallbackSymbol, decimals: fallbackDecimals };
  const [symbol, value] = token as [string, any];
  return { symbol, decimals: Number(value?.decimals ?? fallbackDecimals) };
}

function receiptTokenMeta(protocol: string, action: string, tokenOutMeta: { symbol: string; decimals: number }): { symbol: string; decimals: number } {
  if (!["supply", "supply_collateral", "deposit"].includes(action.toLowerCase())) return tokenOutMeta;
  if (protocol === "ETH_AAVE_V3") return { symbol: "aEthWETH", decimals: 18 };
  if (protocol === "BASE_MORPHO_BLUE") return { symbol: `Morpho ${tokenOutMeta.symbol} shares`, decimals: tokenOutMeta.decimals };
  return tokenOutMeta;
}

function stringToBytes32(value: string): Hex {
  const hex = Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
  return `0x${hex}` as Hex;
}
