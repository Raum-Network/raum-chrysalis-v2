import { createWalletClient, createPublicClient, http, isAddress, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, findChainByKey } from "../../config/index.js";
import type { IntentReceipt, NftReceipt } from "../../types.js";
import { evmTransactionFeeLine, sumFeeLinesUsd } from "../fees/transactionFeeUtils.js";
import { formatUnitsDecimal } from "../../utils/amounts.js";

const RECEIPT_NFT_ABI = parseAbi([
  "function mintReceipt(address beneficiary, string intentId, string sourceChain, string destinationChain, string protocol, string action, string asset, string amountIn, string amountOut, string routeKind, string txHash) external returns (uint256)",
  "function mintReceiptV2(address beneficiary, string intentId, string sourceChain, string destinationChain, string protocol, string action, string asset, string amountIn, string amountOut, string routeKind, string txHash, string destinationRecipient) external returns (uint256)",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function intentToToken(string) external view returns (uint256)",
  "function tokenURI(uint256) external view returns (string)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error AlreadyMinted(string intentId)",
  "error EmptyIntentId()",
  "error ZeroAddress()",
  "event ReceiptMinted(uint256 indexed tokenId, string indexed intentId, address indexed beneficiary, string protocol, string action, string asset, string amountIn, string routeKind)"
]);

const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6" as const;

/**
 * Mints an on-chain ERC-721 receipt NFT on Arc Testnet after a successful
 * cross-chain intent execution.  The NFT is sent to the user's wallet and
 * permanently records the protocol, action, amounts, route, and destination
 * tx hash for provenance and portfolio tracking.
 *
 * Requirements:
 *   - ARC_RECEIPT_NFT_ADDRESS  (from running DeployReceiptNFT.s.sol)
 *   - OPERATOR_PRIVATE_KEY     (wallet holding MINTER_ROLE on the NFT contract)
 */
export class ArcReceiptMinter {
  private readonly nftAddress = process.env.ARC_RECEIPT_NFT_ADDRESS as Hex | undefined;

  async mint(receipt: IntentReceipt): Promise<NftReceipt> {
    const contractAddress = this.nftAddress;

    // ── Guard: contract not yet deployed ────────────────────────────────────
    if (!contractAddress) {
      return {
        network: "ARC",
        skipped: true,
        reason: "ARC_RECEIPT_NFT_ADDRESS not configured. Deploy contracts/src/ArcReceiptNFT.sol to Arc Testnet first."
      };
    }

    // ── Guard: no operator key ──────────────────────────────────────────────
    if (!env.operatorPrivateKey) {
      return {
        network: "ARC",
        skipped: true,
        reason: "OPERATOR_PRIVATE_KEY not set — cannot sign NFT mint transaction."
      };
    }

    // The receipt NFT lives on Arc (EVM), while the intent recipient may be a
    // Stellar/Solana address for non-EVM routes. Mint to the connected EVM
    // source wallet when provided, and only use input.recipient if it is EVM.
    const beneficiary = evmBeneficiaryForReceipt(receipt);
    if (!beneficiary) {
      return {
        network: "ARC",
        skipped: true,
        reason: "Intent has no EVM wallet address for the Arc receipt NFT. Connect an EVM wallet and retry."
      };
    }

    // ── Demo / dry-run mode ─────────────────────────────────────────────────
    if (env.demoMode) {
      const mockTokenId = String(Math.floor(Math.random() * 9_000) + 1_000);
      return {
        network: "ARC",
        tokenId: mockTokenId,
        contractAddress,
        skipped: false,
        reason: "DEMO_MODE: NFT mint simulated (no real transaction submitted)."
      };
    }

    // ── Live mint ────────────────────────────────────────────────────────────
    try {
      const arcChain = findChainByKey("ARC");
      const rpcUrl = process.env.ARC_RPC_URL ?? arcChain.rpcUrl;

      const account = privateKeyToAccount(env.operatorPrivateKey as Hex);
      const viemChain = {
        id: arcChain.chainId,
        name: arcChain.name,
        nativeCurrency: arcChain.nativeCurrency ?? { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
      };

      const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });
      const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

      const canMint = await publicClient.readContract({
        address: contractAddress,
        abi: RECEIPT_NFT_ABI,
        functionName: "hasRole",
        args: [MINTER_ROLE, account.address]
      }) as boolean;

      if (!canMint) {
        return {
          network: "ARC",
          skipped: true,
          reason: `NFT mint skipped: operator ${account.address} does not have MINTER_ROLE on ${contractAddress}.`
        };
      }

      // ── Idempotency check: has this intent already been minted? ───────────
      const existingTokenId = await publicClient.readContract({
        address: contractAddress,
        abi: RECEIPT_NFT_ABI,
        functionName: "intentToToken",
        args: [receipt.id]
      }) as bigint;

      if (existingTokenId > 0n) {
        // Already minted — fetch tokenURI to confirm
        const tokenId = String(existingTokenId);
        return {
          network: "ARC",
          tokenId,
          contractAddress,
          skipped: false,
          reason: `NFT already minted for intent ${receipt.id} (tokenId: ${tokenId}) — idempotent retry`
        };
      }

      // Extract protocol receipt data
      const protocolReceipt = receipt.protocolReceipt ?? {};
      const bridgeReceipt = receipt.bridgeReceipt ?? {};
      const destTxHash = String(
        protocolReceipt.txHash ??
        protocolReceipt.stellarTxHash ??
        protocolReceipt.solanaTxHash ??
        bridgeReceipt.txHash ??
        bridgeReceipt.stellarTxHash ??
        bridgeReceipt.solanaTxHash ??
        bridgeReceipt.mintTxHash ??
        ""
      );
      const amountIn = String(
        protocolReceipt.executedAmountUsdc
          ? `${protocolReceipt.executedAmountUsdc} ${protocolReceipt.tokenInSymbol ?? receipt.input.asset}`
          : `${receipt.plan?.executionAmount ?? receipt.input.amount} ${receipt.input.asset}`
      );
      const outputSymbol = outputSymbolForReceipt(receipt);
      const amountOut = amountOutForReceipt(receipt, outputSymbol);
      const receiptAsset = outputSymbol || receipt.input.asset;
      const routeKind = String(receipt.plan?.routeKind ?? "UNKNOWN");
      const destinationRecipient = destinationRecipientForReceipt(receipt);

      const mintHash = await walletClient.writeContract({
        address: contractAddress,
        abi: RECEIPT_NFT_ABI,
        functionName: "mintReceiptV2",
        args: [
          beneficiary,
          receipt.id,
          receipt.input.sourceChain,
          receipt.input.destinationChain,
          receipt.input.protocol,
          receipt.input.action,
          receiptAsset,
          amountIn,
          amountOut,
          routeKind,
          destTxHash,
          destinationRecipient
        ]
      });

      const txReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
      const feeLine = await evmTransactionFeeLine({
        chainKey: "ARC",
        label: "Arc receipt NFT mint",
        txHash: mintHash,
        chargedBy: "destination_chain",
        payer: "developer",
        receipt: txReceipt
      });
      const feeLines = feeLine ? [feeLine] : [];

      // Extract tokenId from the ReceiptMinted event (first indexed topic = tokenId)
      const RECEIPT_MINTED_TOPIC = "0x5eb3c1a7abb23aca502a8775a6458ad57ed5170dfceccfed60a5e61d6e77da57";
      const mintLog = txReceipt.logs.find((log) =>
        log.address.toLowerCase() === contractAddress.toLowerCase() &&
        log.topics?.[0] === RECEIPT_MINTED_TOPIC
      );
      const tokenIdHex = mintLog?.topics?.[1];
      const tokenId = tokenIdHex ? String(BigInt(tokenIdHex)) : String(existingTokenId);

      return {
        network: "ARC",
        tokenId,
        mintTxHash: mintHash,
        contractAddress,
        feeLines,
        actualFeeUsd: sumFeeLinesUsd(feeLines)
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ArcReceiptMinter] mint failed:", message);
      return {
        network: "ARC",
        skipped: true,
        reason: `NFT mint failed: ${message}`
      };
    }
  }
}

export const arcReceiptMinter = new ArcReceiptMinter();

function evmBeneficiaryForReceipt(receipt: IntentReceipt): Hex | undefined {
  const metadata = receipt.input.metadata ?? {};
  const candidates = [
    metadata.evmReceiptWalletAddress,
    metadata.sourceWalletAddress,
    metadata.gatewayDepositor,
    metadata.evmAddress,
    receipt.input.recipient,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && isAddress(candidate)) return candidate as Hex;
  }

  return undefined;
}

function destinationRecipientForReceipt(receipt: IntentReceipt): string {
  const metadata = receipt.input.metadata ?? {};
  const candidates = [
    metadata.destinationRecipient,
    metadata.stellarAddress,
    metadata.solanaAddress,
    receipt.input.recipient,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }

  return "";
}

function outputSymbolForReceipt(receipt: IntentReceipt): string {
  const protocolReceipt = receipt.protocolReceipt ?? {};
  const explicit = protocolReceipt.amountOutSymbol ?? protocolReceipt.tokenOutSymbol ?? protocolReceipt.receiptTokenSymbol;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const quoteSymbol = receipt.plan?.feeQuote?.receiptTokenSymbol ?? receipt.plan?.feeQuote?.outputTokenSymbol;
  if (typeof quoteSymbol === "string" && quoteSymbol.trim()) return quoteSymbol.trim();
  if (receipt.input.protocol === "SOL_MARINADE") return "mSOL";
  return "";
}

function amountOutForReceipt(receipt: IntentReceipt, outputSymbol: string): string {
  const protocolReceipt = receipt.protocolReceipt ?? {};
  const formatted = protocolReceipt.amountOutFormatted;
  if (typeof formatted === "string" && formatted.trim()) {
    return `${formatted.trim()} ${outputSymbol}`.trim();
  }
  const raw = protocolReceipt.amountOutRaw ?? protocolReceipt.amountOut ?? protocolReceipt.amount;
  if (typeof raw === "string" && raw.trim()) {
    const maybeFormatted = outputSymbol === "mSOL" && /^[0-9]+$/.test(raw)
      ? formatUnitsDecimal(BigInt(raw), 9)
      : raw;
    return `${maybeFormatted} ${outputSymbol}`.trim();
  }
  const estimated = receipt.plan?.feeQuote?.estimatedOutputAmount
    ?? receipt.plan?.feeQuote?.estimatedAmountToProtocol
    ?? receipt.input.amount;
  return `${estimated} ${outputSymbol || receipt.input.asset}`.trim();
}
