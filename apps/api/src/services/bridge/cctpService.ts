import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  createWalletClient, createPublicClient, http, parseAbi,
  type Hex, keccak256, pad, decodeAbiParameters, parseAbiParameters, toBytes, getAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, findChainByKey } from "../../config/index.js";
import { FeeLineItem, RoutePlan } from "../../types.js";
import {
  evmTransactionFeeLine,
  stellarStroopsFeeLine,
  solanaTransactionFeeLine,
  sumFeeLinesUsd
} from "../fees/transactionFeeUtils.js";

import {
  Connection, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, SYSVAR_RENT_PUBKEY, Keypair
} from "@solana/web3.js";
import { sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Address as StellarAddress,
  Keypair as StellarKeypair,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  xdr,
  Contract,
  StrKey,
  Asset,
  Operation,
  Account as StellarAccount
} from "@stellar/stellar-sdk";

const IRIS_API = env.circleIrisApiUrl || "https://iris-api-sandbox.circle.com";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC_TEMP_SEED = "usdc-temp-v1";

const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external returns (uint64 nonce)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) external returns (uint64 nonce)",
]);

const messageTransmitterV2Abi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) external returns (bool success)",
]);

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const MESSAGE_SENT_TOPIC = keccak256(toBytes("MessageSent(bytes)"));

interface IrisAttestationMessage {
  message?: string;
  eventNonce?: string;
  attestation?: string;
  status?: string;
  decodedMessage?: {
    sourceDomain?: string;
    destinationDomain?: string;
    decodedMessageBody?: {
      burnToken?: string;
      mintRecipient?: string;
      amount?: string;
    };
  };
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function sameAddress(left?: string, right?: string): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export class CctpService {

  describeRoute(plan: RoutePlan): Record<string, unknown> {
    const source = findChainByKey(plan.sourceChain);
    const destination = findChainByKey(plan.destinationChain);
    return {
      sourceDomain: source.cctpDomain,
      destinationDomain: destination.cctpDomain,
      sourceVm: source.vm,
      destinationVm: destination.vm,
      method: "CCTP_V2",
      circleProduct: plan.feeQuote?.circleProduct,
      quotedBridgeFeeUsd: plan.feeQuote?.bridgeFeeUsd,
      quotedCircleFeeBps: plan.feeQuote?.circleFeeBps
    };
  }

  async executeBridge(plan: RoutePlan): Promise<Record<string, unknown>> {
    if (env.demoMode) {
      return {
        status: "mocked",
        cctpTransferId: `cctp_${Date.now().toString(36)}`,
        circleProduct: "CCTP V2",
        note: "DEMO_MODE enabled."
      };
    }

    try {
      if (!env.operatorPrivateKey) {
        return { status: "bridge_failed", reason: "OPERATOR_PRIVATE_KEY not set." };
      }

      const srcChain = findChainByKey(plan.sourceChain);
      const dstChain = findChainByKey(plan.destinationChain);

      const account = privateKeyToAccount(env.operatorPrivateKey as Hex);

      const mkChain = (c: any, rpc: string) => ({
        id: c.chainId, name: c.name,
        nativeCurrency: c.nativeCurrency ?? { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } }
      });

      const actualFeeLines: FeeLineItem[] = [];

      const amount = BigInt(Math.floor(Number(plan.amount) * 1_000_000));
      const dstDomain = dstChain.cctpDomain as number;

      const dstVm = dstChain.vm as string;

      let mintRecipient: Hex;
      let destinationCaller: Hex = "0x" + "00".repeat(32) as Hex;
      let solanaRecipientPubkey: PublicKey | null = null;
      let stellarRecipientRaw: string | null = null;
      let hookData: Hex | undefined;

      const bridgeOnly = isBridgeOnlyProtocol(plan.protocol);

      if (dstVm === "evm") {
        const dstRouter = plan.destinationChain === "BASE_SEPOLIA" ? env.baseRouterAddress
          : plan.destinationChain === "ARC" ? env.arcRouterAddress
          : plan.destinationChain === "ETHEREUM_SEPOLIA" ? env.ethereumRouterAddress
          : "";
        const mintRecipientAddr = (bridgeOnly && plan.recipient ? plan.recipient : dstRouter || account.address) as Hex;
        mintRecipient = pad(mintRecipientAddr, { size: 32 });
      } else if (dstVm === "svm") {
        const solanaKeypair = loadSolanaKeypair();
        const userSolanaAddr = plan.recipient?.trim() || "";
        if (userSolanaAddr) {
          try {
            solanaRecipientPubkey = new PublicKey(userSolanaAddr);
          } catch {
            return { status: "bridge_failed", reason: `Invalid Solana recipient address: ${userSolanaAddr}` };
          }
        } else {
          solanaRecipientPubkey = solanaKeypair.publicKey;
        }
        const usdcMint = new PublicKey(dstChain.tokens?.USDC?.mint);
        // Use operator-derived temp account (ATA program not deployed on devnet)
        const recipientTemp = await PublicKey.createWithSeed(solanaKeypair.publicKey, USDC_TEMP_SEED, TOKEN_PROGRAM_ID);
        mintRecipient = `0x${Buffer.from(recipientTemp.toBytes()).toString("hex")}` as Hex;
      } else if (dstVm === "soroban") {
        const stellarKeypair = loadStellarKeypair();
        const userStellarAddr = plan.recipient?.trim() || "";
        const isUserProvided = userStellarAddr.length > 0;
        if (isUserProvided && !StrKey.isValidEd25519PublicKey(userStellarAddr)) {
          return { status: "bridge_failed", reason: `Invalid Stellar recipient address: ${userStellarAddr}` };
        }
        
        // If there is a downstream protocol intent, bridge to the Operator so it can act as the relayer.
        const hasDownstreamIntent = Boolean(plan.protocol && plan.protocol.length > 0 && plan.protocol !== "LOCAL" && !bridgeOnly);
        stellarRecipientRaw = (isUserProvided && !hasDownstreamIntent) ? userStellarAddr : stellarKeypair.publicKey();
        const cctpForwarderAddr = dstChain.circle?.cctp?.cctpForwarder as string | undefined;
        if (!cctpForwarderAddr) {
          return { status: "bridge_failed", reason: "CctpForwarder contract not configured for Stellar." };
        }
        const forwarderBytes = StrKey.decodeContract(cctpForwarderAddr);
        mintRecipient = `0x${Buffer.from(forwarderBytes).toString("hex")}` as Hex;
        destinationCaller = mintRecipient;

        // Only attempt trustline for operator's own keypair (cannot create for arbitrary users)
        if (!isUserProvided) {
          const stellarRpc = process.env[dstChain.rpcEnv] ?? dstChain.rpcUrl;
          const stellarServer = new SorobanRpc.Server(stellarRpc);
          const usdcAssetCode = dstChain.tokens?.USDC?.assetCode ?? "USDC";
          const usdcAssetIssuer = dstChain.tokens?.USDC?.assetIssuer;
          if (usdcAssetIssuer) {
            await ensureStellarTrustline(stellarServer, stellarKeypair, usdcAssetCode, usdcAssetIssuer);
          }
        }

        // Build hook data per Circle CctpForwarder format:
        //   bytes  0-23: reserved (zero)
        //   bytes 24-27: hook version (uint32 BE = 0)
        //   bytes 28-31: forwardRecipient byte length (uint32 BE)
        //   bytes 32+  : forwardRecipient strkey as UTF-8
        const forwardRecipientBytes = Buffer.from(stellarRecipientRaw, "utf8");
        const hookBuffer = Buffer.alloc(32 + forwardRecipientBytes.length);
        hookBuffer.writeUInt32BE(0, 24);                     // hook version
        hookBuffer.writeUInt32BE(forwardRecipientBytes.length, 28); // strkey length
        forwardRecipientBytes.copy(hookBuffer, 32);          // strkey bytes
        hookData = `0x${hookBuffer.toString("hex")}` as Hex;
      } else {
        return {
          status: "bridge_failed",
          reason: `Unsupported destination VM type: ${dstVm} for chain ${plan.destinationChain}.`
        };
      }

      console.log(`[CCTP] Starting: ${plan.amount} USDC from ${plan.sourceChain} → ${plan.destinationChain} (vm=${dstVm})`);
      console.log(`[CCTP] Mint recipient (${dstVm}): ${mintRecipient}`);
      console.log(`[CCTP] Destination caller: ${destinationCaller}`);
      if (hookData) console.log(`[CCTP] Hook data (forwardRecipient): ${hookData}`);

      let approveTxHash: Hex | undefined;
      let burnTxHash: string;
      let burnBlockNumber: string | undefined;
      let messageHash: Hex | undefined;
      let sourceUsdcForValidation: string | undefined;

      if (srcChain.vm === "evm") {
        const tokenMessengerAddr = srcChain.circle?.cctp?.tokenMessengerV2 as string | undefined;
        const srcMessageTransmitterAddr = srcChain.circle?.cctp?.messageTransmitterV2 as string | undefined;
        if (!tokenMessengerAddr || !srcMessageTransmitterAddr) {
          return {
            status: "bridge_failed",
            reason: `CCTP V2 contracts not configured for source chain ${plan.sourceChain}. Need tokenMessengerV2 and messageTransmitterV2 in chains.json.`
          };
        }

        const srcRpc = process.env[srcChain.rpcEnv] ?? srcChain.rpcUrl;
        const srcWallet = createWalletClient({ account, chain: mkChain(srcChain, srcRpc), transport: http(srcRpc) });
        const srcPublic = createPublicClient({ chain: mkChain(srcChain, srcRpc), transport: http(srcRpc) });
        const sourceUsdc = srcChain.tokens?.USDC?.address as Hex;
        sourceUsdcForValidation = sourceUsdc;

        const balance = await srcPublic.readContract({
          address: sourceUsdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address]
        });
        if (balance < amount) {
          return { status: "bridge_failed", reason: `Insufficient USDC on ${plan.sourceChain}. Have ${Number(balance) / 1e6}, need ${plan.amount}.` };
        }

        const allowance = await srcPublic.readContract({
          address: sourceUsdc, abi: erc20Abi, functionName: "allowance",
          args: [account.address, tokenMessengerAddr as Hex]
        });
        if (allowance < amount) {
          console.log(`[CCTP] Step 1/4: Approving USDC for TokenMessenger...`);
          approveTxHash = await srcWallet.writeContract({
            address: sourceUsdc, abi: erc20Abi, functionName: "approve",
            args: [tokenMessengerAddr as Hex, amount]
          });
          const approveReceipt = await srcPublic.waitForTransactionReceipt({ hash: approveTxHash });
          const feeLine = await evmTransactionFeeLine({
            chainKey: plan.sourceChain,
            label: "CCTP source approve",
            txHash: approveTxHash,
            chargedBy: "source_chain",
            payer: "developer",
            receipt: approveReceipt
          });
          if (feeLine) actualFeeLines.push(feeLine);
          console.log(`[CCTP] Approve tx: ${approveTxHash}`);
        } else {
          console.log(`[CCTP] Step 1/4: Allowance sufficient.`);
        }

        console.log(`[CCTP] Step 2/4: depositForBurn → domain ${dstDomain}...`);
        const commonArgs = [amount, dstDomain, mintRecipient, sourceUsdc, destinationCaller, 0n, 2000] as const;
        burnTxHash = hookData
          ? await srcWallet.writeContract({
              address: tokenMessengerAddr as Hex,
              abi: tokenMessengerV2Abi,
              functionName: "depositForBurnWithHook",
              args: [...commonArgs, hookData],
            })
          : await srcWallet.writeContract({
              address: tokenMessengerAddr as Hex,
              abi: tokenMessengerV2Abi,
              functionName: "depositForBurn",
              args: commonArgs,
            });
        const burnReceipt = await srcPublic.waitForTransactionReceipt({ hash: burnTxHash as Hex });
        const burnFeeLine = await evmTransactionFeeLine({
          chainKey: plan.sourceChain,
          label: "CCTP source depositForBurn",
          txHash: burnTxHash as Hex,
          chargedBy: "source_chain",
          payer: "developer",
          receipt: burnReceipt
        });
        if (burnFeeLine) actualFeeLines.push(burnFeeLine);
        burnBlockNumber = burnReceipt.blockNumber.toString();
        console.log(`[CCTP] Burn tx: ${burnTxHash} (block ${burnReceipt.blockNumber})`);

        const msgLog = burnReceipt.logs.find(l =>
          l.address.toLowerCase() === srcMessageTransmitterAddr.toLowerCase() &&
          l.topics[0] === MESSAGE_SENT_TOPIC
        );
        if (!msgLog) {
          return {
            status: "bridge_pending", burnTxHash,
            feeLines: actualFeeLines,
            actualFeeUsd: sumFeeLinesUsd(actualFeeLines),
            reason: "Burn succeeded but MessageSent event not found in logs."
          };
        }

        const [messageBytes] = decodeAbiParameters(
          parseAbiParameters("bytes message"), msgLog.data as Hex
        );
        messageHash = keccak256(messageBytes as Hex);
        console.log(`[CCTP] MessageSent hash: ${messageHash}`);
      } else if (srcChain.vm === "svm") {
        console.log(`[CCTP] Step 1/4: Solana source does not need EVM approval.`);
        const solanaBurn = await this.burnFromSolanaSource(srcChain, amount, dstDomain, mintRecipient, destinationCaller, hookData);
        if (!solanaBurn.success) {
          return { status: "bridge_failed", reason: solanaBurn.message ?? "Solana CCTP burn failed.", recoverable: true };
        }
        burnTxHash = solanaBurn.txHash!;
        messageHash = solanaBurn.messageHash;
        actualFeeLines.push(...(solanaBurn.feeLines ?? []));
      } else if (srcChain.vm === "soroban") {
        console.log(`[CCTP] Step 1/4: Stellar source approve + burn.`);
        const stellarBurn = await this.burnFromStellarSource(srcChain, plan.amount, amount, dstDomain, mintRecipient, destinationCaller, hookData);
        if (!stellarBurn.success) {
          return { status: "bridge_failed", reason: stellarBurn.message ?? "Stellar CCTP burn failed.", recoverable: true };
        }
        burnTxHash = stellarBurn.txHash!;
        actualFeeLines.push(...(stellarBurn.feeLines ?? []));
      } else {
        return { status: "bridge_failed", reason: `Unsupported CCTP source VM type: ${srcChain.vm} for chain ${plan.sourceChain}.` };
      }

      console.log(`[CCTP] Step 3/4: Polling Iris API for attestation...`);
      let attestationMessage: IrisAttestationMessage | null = null;
      const maxPollMs = 20 * 60 * 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxPollMs) {
        try {
          const srcDomain = srcChain.cctpDomain;
          const res = await fetch(`${IRIS_API}/v2/messages/${srcDomain}?transactionHash=${burnTxHash}`);
          if (res.ok) {
            const data = await res.json() as any;
            if (Array.isArray(data.messages) && data.messages.length > 0) {
              const completeMessages = (data.messages as IrisAttestationMessage[]).filter(msg =>
                msg.status === "complete" &&
                isHex(msg.message) &&
                isHex(msg.attestation) &&
                msg.attestation !== "0x"
              );
              const matchingMessage = messageHash
                ? completeMessages.find(msg => keccak256(msg.message as Hex) === messageHash)
                : undefined;
              const msg = matchingMessage ?? completeMessages[0];
              if (msg) {
                attestationMessage = msg;
                console.log(`[CCTP] Attestation received after ${Math.round((Date.now() - startTime) / 1000)}s.`);
                break;
              }
            }
          } else {
            console.log(`[CCTP] Iris API returned status ${res.status}`);
          }
        } catch (e) {
          console.error("[CCTP] Error polling Iris API:", e);
        }
        await new Promise(r => setTimeout(r, 5000));
      }

      if (!attestationMessage?.message || !attestationMessage.attestation) {
        return {
          status: "bridge_pending", burnTxHash, messageHash,
          feeLines: actualFeeLines,
          actualFeeUsd: sumFeeLinesUsd(actualFeeLines),
          reason: `Attestation not received within ${maxPollMs / 1000}s. Bridge may complete later.`
        };
      }

      const decodedMessage = attestationMessage.decodedMessage;
      const decodedBody = decodedMessage?.decodedMessageBody;
      if (decodedMessage?.sourceDomain && Number(decodedMessage.sourceDomain) !== Number(srcChain.cctpDomain)) {
        return { status: "bridge_failed", burnTxHash, messageHash, reason: `Iris attestation source domain mismatch. Expected ${srcChain.cctpDomain}, got ${decodedMessage.sourceDomain}.` };
      }
      if (decodedMessage?.destinationDomain && Number(decodedMessage.destinationDomain) !== Number(dstDomain)) {
        return { status: "bridge_failed", burnTxHash, messageHash, reason: `Iris attestation destination domain mismatch. Expected ${dstDomain}, got ${decodedMessage.destinationDomain}.` };
      }
      if (decodedBody?.amount && BigInt(decodedBody.amount) !== amount) {
        return { status: "bridge_failed", burnTxHash, messageHash, reason: `Iris attestation amount mismatch. Expected ${amount.toString()}, got ${decodedBody.amount}.` };
      }
      if (sourceUsdcForValidation && decodedBody?.burnToken && !sameAddress(decodedBody.burnToken, sourceUsdcForValidation)) {
        return { status: "bridge_failed", burnTxHash, messageHash, reason: `Iris attestation burn token mismatch. Expected ${sourceUsdcForValidation}, got ${decodedBody.burnToken}.` };
      }

      const attestedMessageBytes = attestationMessage.message as Hex;
      const attestedMessageHash = keccak256(attestedMessageBytes);

      if (dstVm === "evm") {
        const dstMessageTransmitterAddr = dstChain.circle?.cctp?.messageTransmitterV2 as string | undefined;
        if (!dstMessageTransmitterAddr) {
          return {
            status: "bridge_failed", burnTxHash, messageHash,
            reason: `CCTP V2 messageTransmitterV2 not configured for destination chain ${plan.destinationChain}.`
          };
        }

        const dstRpc = process.env[dstChain.rpcEnv] ?? dstChain.rpcUrl;
        const dstWallet = createWalletClient({ account, chain: mkChain(dstChain, dstRpc), transport: http(dstRpc) });
        const dstPublic = createPublicClient({ chain: mkChain(dstChain, dstRpc), transport: http(dstRpc) });

        console.log(`[CCTP] Step 4/4: receiveMessage on ${plan.destinationChain} (EVM)...`);
        const mintTxHash = await dstWallet.writeContract({
          address: dstMessageTransmitterAddr as Hex,
          abi: messageTransmitterV2Abi,
          functionName: "receiveMessage",
          args: [attestedMessageBytes, attestationMessage.attestation as Hex]
        });
        const mintReceipt = await dstPublic.waitForTransactionReceipt({ hash: mintTxHash });
        const mintFeeLine = await evmTransactionFeeLine({
          chainKey: plan.destinationChain,
          label: "CCTP destination receiveMessage",
          txHash: mintTxHash,
          chargedBy: "destination_chain",
          payer: "developer",
          receipt: mintReceipt
        });
        if (mintFeeLine) actualFeeLines.push(mintFeeLine);
        console.log(`[CCTP] Mint tx: ${mintTxHash} (block ${mintReceipt.blockNumber})`);

        return {
          status: "submitted",
          approveTxHash,
          burnTxHash,
          mintTxHash,
          messageHash: attestedMessageHash,
          localMessageHash: messageHash,
          eventNonce: attestationMessage.eventNonce,
          burnBlockNumber,
          mintBlockNumber: mintReceipt.blockNumber.toString(),
          circleProduct: "CCTP V2",
          cctpMode: "standard",
          destinationVm: "evm",
          feeLines: actualFeeLines,
          actualFeeUsd: sumFeeLinesUsd(actualFeeLines)
        };
      }

      if (dstVm === "svm") {
        console.log(`[CCTP] Step 4/4: receiveMessage on Solana...`);
        const solanaResult = await this.receiveOnSolana(
          dstChain,
          attestedMessageBytes,
          attestationMessage.attestation as Hex,
          solanaRecipientPubkey!,
          amount
        );
        actualFeeLines.push(...(solanaResult.feeLines ?? []));
        return {
          status: solanaResult.success ? "submitted" : "bridge_pending",
          approveTxHash,
          burnTxHash,
          messageHash: attestedMessageHash,
          localMessageHash: messageHash,
          eventNonce: attestationMessage.eventNonce,
          burnBlockNumber,
          solanaTxHash: solanaResult.txHash,
          solanaSetupTxHash: solanaResult.setupTxHash,
          solanaMessage: solanaResult.message,
          circleProduct: "CCTP V2",
          cctpMode: "standard",
          destinationVm: "svm",
          feeLines: actualFeeLines,
          actualFeeUsd: sumFeeLinesUsd(actualFeeLines)
        };
      }

      if (dstVm === "soroban") {
        console.log(`[CCTP] Step 4/4: receiveMessage on Stellar via CctpForwarder...`);
        const stellarResult = await this.receiveOnStellar(
          dstChain,
          attestedMessageBytes,
          attestationMessage.attestation as Hex
        );
        actualFeeLines.push(...(stellarResult.feeLines ?? []));
        return {
          status: stellarResult.success ? "submitted" : "bridge_pending",
          approveTxHash,
          burnTxHash,
          messageHash: attestedMessageHash,
          localMessageHash: messageHash,
          eventNonce: attestationMessage.eventNonce,
          burnBlockNumber,
          stellarTxHash: stellarResult.txHash,
          stellarMessage: stellarResult.message,
          circleProduct: "CCTP V2",
          cctpMode: "standard",
          destinationVm: "soroban",
          feeLines: actualFeeLines,
          actualFeeUsd: sumFeeLinesUsd(actualFeeLines)
        };
      }

      return { status: "bridge_failed", burnTxHash, messageHash, reason: `Unknown destination VM: ${dstVm}` };

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[CctpService] bridge failed:", message);
      return { status: "bridge_failed", reason: message, recoverable: true };
    }
  }

  private async burnFromSolanaSource(
    srcChain: any,
    amount: bigint,
    dstDomain: number,
    mintRecipient: Hex,
    destinationCaller: Hex,
    hookData?: Hex
  ): Promise<{ success: boolean; txHash?: string; messageHash?: Hex; message?: string; feeLines?: FeeLineItem[] }> {
    try {
      const rpcUrl = process.env[srcChain.rpcEnv] ?? srcChain.rpcUrl;
      const connection = new Connection(rpcUrl, "confirmed");
      const solanaKeypair = loadSolanaKeypair();
      const tokenMessengerMinterId = new PublicKey(srcChain.circle?.cctp?.tokenMessengerV2);
      const messageTransmitterId = new PublicKey(srcChain.circle?.cctp?.messageTransmitterV2);
      const usdcMint = new PublicKey(srcChain.tokens?.USDC?.mint);
      const senderUsdcAccount = getAssociatedTokenAddressSync(usdcMint, solanaKeypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const balance = await connection.getTokenAccountBalance(senderUsdcAccount).catch(() => null);
      const rawBalance = BigInt(balance?.value?.amount ?? "0");
      if (rawBalance < amount) {
        return { success: false, message: `Insufficient Solana USDC. Have ${Number(rawBalance) / 1e6}, need ${Number(amount) / 1e6}.` };
      }

      const [senderAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("sender_authority")], tokenMessengerMinterId);
      const [denylistPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("denylist_account"), solanaKeypair.publicKey.toBytes()],
        tokenMessengerMinterId
      );
      const [messageTransmitter] = PublicKey.findProgramAddressSync([Buffer.from("message_transmitter")], messageTransmitterId);
      const [tokenMessenger] = PublicKey.findProgramAddressSync([Buffer.from("token_messenger")], tokenMessengerMinterId);
      const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
        [Buffer.from("remote_token_messenger"), Buffer.from(String(dstDomain))],
        tokenMessengerMinterId
      );
      const [tokenMinter] = PublicKey.findProgramAddressSync([Buffer.from("token_minter")], tokenMessengerMinterId);
      const [localToken] = PublicKey.findProgramAddressSync(
        [Buffer.from("local_token"), usdcMint.toBytes()],
        tokenMessengerMinterId
      );
      const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], tokenMessengerMinterId);
      const messageSentEventAccount = Keypair.generate();

      const fixedData = Buffer.concat([
        u64Le(amount),
        u32Le(dstDomain),
        hexBytes32ToBuffer(mintRecipient),
        hexBytes32ToBuffer(destinationCaller),
        u64Le(0n),
        u32Le(2000),
      ]);
      const hookBuffer = hookData ? Buffer.from(hookData.slice(2), "hex") : undefined;
      const data = hookBuffer
        ? Buffer.concat([anchorDiscriminator("deposit_for_burn_with_hook"), fixedData, u32Le(hookBuffer.length), hookBuffer])
        : Buffer.concat([anchorDiscriminator("deposit_for_burn"), fixedData]);

      const accounts = [
        { pubkey: solanaKeypair.publicKey, isSigner: true, isWritable: false }, // owner
        { pubkey: solanaKeypair.publicKey, isSigner: true, isWritable: true },  // event rent payer
        { pubkey: senderAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: senderUsdcAccount, isSigner: false, isWritable: true },
        { pubkey: denylistPda, isSigner: false, isWritable: false },
        { pubkey: messageTransmitter, isSigner: false, isWritable: true },
        { pubkey: tokenMessenger, isSigner: false, isWritable: false },
        { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
        { pubkey: tokenMinter, isSigner: false, isWritable: false },
        { pubkey: localToken, isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: true },
        { pubkey: messageSentEventAccount.publicKey, isSigner: true, isWritable: true },
        { pubkey: messageTransmitterId, isSigner: false, isWritable: false },
        { pubkey: tokenMessengerMinterId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: tokenMessengerMinterId, isSigner: false, isWritable: false },
      ];

      const tx = new Transaction().add(new TransactionInstruction({
        programId: tokenMessengerMinterId,
        keys: accounts,
        data
      }));
      tx.feePayer = solanaKeypair.publicKey;
      const signature = await sendAndConfirmTransaction(connection, tx, [solanaKeypair, messageSentEventAccount], {
        commitment: "confirmed"
      });
      const feeLine = await solanaTransactionFeeLine({
        connection,
        label: "CCTP Solana source depositForBurn",
        txHash: signature,
        chargedBy: "source_chain",
        payer: "developer"
      });
      console.log(`[CCTP] Solana burn tx: ${signature}; event account: ${messageSentEventAccount.publicKey.toBase58()}`);
      return { success: true, txHash: signature, feeLines: feeLine ? [feeLine] : [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[CCTP] Solana source burn error:", msg);
      return { success: false, message: msg };
    }
  }

  private async burnFromStellarSource(
    srcChain: any,
    displayAmount: string,
    canonicalAmount: bigint,
    dstDomain: number,
    mintRecipient: Hex,
    destinationCaller: Hex,
    hookData?: Hex
  ): Promise<{ success: boolean; txHash?: string; message?: string; feeLines?: FeeLineItem[] }> {
    try {
      const rpcUrl = process.env[srcChain.rpcEnv] ?? srcChain.rpcUrl;
      const server = new SorobanRpc.Server(rpcUrl);
      const stellarKeypair = loadStellarKeypair();
      const tokenMessengerMinterId = srcChain.circle?.cctp?.tokenMessengerMinter as string | undefined;
      const usdcContractId = srcChain.tokens?.USDC?.contract as string | undefined;
      if (!tokenMessengerMinterId || !usdcContractId) {
        return { success: false, message: "Stellar CCTP TokenMessengerMinter or USDC contract missing from chain config." };
      }

      const tokenMessenger = new Contract(tokenMessengerMinterId);
      const usdc = new Contract(usdcContractId);
      const stellarAmount = BigInt(Math.floor(Number(displayAmount) * 10_000_000));
      if (stellarAmount <= 0n || canonicalAmount <= 0n) {
        return { success: false, message: "CCTP amount must be greater than zero." };
      }

      const latestLedger = await server.getLatestLedger() as any;
      const expirationLedger = Number(latestLedger.sequence ?? latestLedger.latestLedger ?? 0) + 17280;
      const caller = new StellarAddress(stellarKeypair.publicKey()).toScVal();
      const spender = new StellarAddress(tokenMessengerMinterId).toScVal();
      const burnToken = new StellarAddress(usdcContractId).toScVal();
      const approveCall = usdc.call(
        "approve",
        caller,
        spender,
        nativeToScVal(stellarAmount, { type: "i128" }),
        nativeToScVal(expirationLedger, { type: "u32" })
      );
      const burnArgs = [
        caller,
        nativeToScVal(stellarAmount, { type: "i128" }),
        nativeToScVal(dstDomain, { type: "u32" }),
        xdr.ScVal.scvBytes(hexBytes32ToBuffer(mintRecipient)),
        burnToken,
        xdr.ScVal.scvBytes(hexBytes32ToBuffer(destinationCaller)),
        nativeToScVal(0n, { type: "i128" }),
        nativeToScVal(2000, { type: "u32" }),
      ];
      const burnCall = hookData
        ? tokenMessenger.call("deposit_for_burn_with_hook", ...burnArgs, xdr.ScVal.scvBytes(Buffer.from(hookData.slice(2), "hex")))
        : tokenMessenger.call("deposit_for_burn", ...burnArgs);

      let approveTx = new TransactionBuilder(await server.getAccount(stellarKeypair.publicKey()), {
        fee: String(Number(BASE_FEE) * 200),
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(approveCall)
        .setTimeout(300)
        .build();

      approveTx = await server.prepareTransaction(approveTx);
      approveTx.sign(stellarKeypair);
      const approveSent = await server.sendTransaction(approveTx);
      if (approveSent.status !== "PENDING" && approveSent.status !== "DUPLICATE") {
        return { success: false, message: `Stellar approve sendTransaction failed: ${approveSent.errorResult?.toString() ?? approveSent.status}` };
      }
      const approveResult = await waitForStellarTransaction(server, approveSent.hash, 60);
      if (approveResult.status !== "SUCCESS") {
        return { success: false, txHash: approveSent.hash, message: `Stellar approve tx not confirmed: ${approveResult.status}` };
      }

      let burnTx = new TransactionBuilder(await server.getAccount(stellarKeypair.publicKey()), {
        fee: String(Number(BASE_FEE) * 200),
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(burnCall)
        .setTimeout(300)
        .build();

      burnTx = await server.prepareTransaction(burnTx);
      burnTx.sign(stellarKeypair);
      const sent = await server.sendTransaction(burnTx);
      if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
        return { success: false, message: `Stellar burn sendTransaction failed: ${sent.errorResult?.toString() ?? sent.status}` };
      }

      const txHash = sent.hash;
      const result = await waitForStellarTransaction(server, txHash, 60);
      if (result.status !== "SUCCESS") {
        return { success: false, txHash, message: `Stellar burn tx not confirmed: ${result.status}` };
      }

      const approveFeeLine = await stellarStroopsFeeLine({
        label: "CCTP Stellar source approve",
        feeStroops: stellarFeeStroops(approveResult, approveTx.fee),
        txHash: approveSent.hash,
        chargedBy: "source_chain",
        payer: "developer"
      });
      const feeLine = await stellarStroopsFeeLine({
        label: "CCTP Stellar source deposit_for_burn",
        feeStroops: stellarFeeStroops(result, burnTx.fee),
        txHash,
        chargedBy: "source_chain",
        payer: "developer"
      });
      console.log(`[CCTP] Stellar burn tx: ${txHash}`);
      return { success: true, txHash, feeLines: [approveFeeLine, feeLine] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[CCTP] Stellar source burn error:", msg);
      return { success: false, message: msg };
    }
  }

  private async receiveOnSolana(
    dstChain: any,
    message: Hex,
    attestation: Hex,
    recipientPubkey: PublicKey,
    amount: bigint
  ): Promise<{ success: boolean; txHash?: string; setupTxHash?: string; message?: string; feeLines?: FeeLineItem[] }> {
    try {
      const rpcUrl = process.env[dstChain.rpcEnv] ?? dstChain.rpcUrl;
      const connection = new Connection(rpcUrl, "confirmed");
      const feeLines: FeeLineItem[] = [];
      let setupTxHash: string | undefined;
      const solanaKeypair = loadSolanaKeypair();
      const messageTransmitterId = new PublicKey(dstChain.circle?.cctp?.messageTransmitterV2);
      const tokenMessengerMinterId = new PublicKey(dstChain.circle?.cctp?.tokenMessengerV2);
      const usdcMint = new PublicKey(dstChain.tokens?.USDC?.mint);

      // Use operator-derived temp account for bridging (no extra signer needed)
      const usdcTemp = await PublicKey.createWithSeed(solanaKeypair.publicKey, USDC_TEMP_SEED, TOKEN_PROGRAM_ID);
      const existingTemp = await connection.getAccountInfo(usdcTemp);
      if (!existingTemp) {
        const tokenAccountSpace = 165;
        const rent = await connection.getMinimumBalanceForRentExemption(tokenAccountSpace);
        const createIx = SystemProgram.createAccountWithSeed({
          fromPubkey: solanaKeypair.publicKey,
          newAccountPubkey: usdcTemp,
          basePubkey: solanaKeypair.publicKey,
          seed: USDC_TEMP_SEED,
          lamports: rent,
          space: tokenAccountSpace,
          programId: TOKEN_PROGRAM_ID,
        });
        const initIx = new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: usdcTemp, isSigner: false, isWritable: true },
            { pubkey: usdcMint, isSigner: false, isWritable: false },
            { pubkey: solanaKeypair.publicKey, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([1]),
        });
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = new Transaction().add(createIx, initIx);
        tx.recentBlockhash = blockhash;
        tx.feePayer = solanaKeypair.publicKey;
        tx.sign(solanaKeypair);
        const sig = await sendAndConfirmTransaction(connection, tx, [solanaKeypair], { commitment: "confirmed" });
        const setupFeeLine = await solanaTransactionFeeLine({
          connection,
          label: "CCTP Solana temp-account setup",
          txHash: sig,
          payer: "developer"
        });
        if (setupFeeLine) feeLines.push(setupFeeLine);
        setupTxHash = sig;
        console.log(`[CCTP] Solana USDC temp account created: ${usdcTemp.toBase58()}, tx: ${sig}`);
      } else {
        console.log(`[CCTP] Solana USDC temp account exists: ${usdcTemp.toBase58()}`);
      }

      const messageBuffer = Buffer.from(message.slice(2), "hex");
      const attestationBuffer = Buffer.from(attestation.slice(2), "hex");

      // Parse source domain from outer CCTP V2 message (bytes 4-8, big endian u32)
      const sourceDomain = messageBuffer.readUInt32BE(4);

      // ==== PDAs on MessageTransmitterV2 ====
      const [messageTransmitterConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("message_transmitter")], messageTransmitterId
      );
      const [usedNonce] = PublicKey.findProgramAddressSync(
        [Buffer.from("used_nonce"), messageBuffer.subarray(12, 44)], messageTransmitterId
      );
      const [authorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("message_transmitter_authority"), tokenMessengerMinterId.toBytes()], messageTransmitterId
      );
      const [eventAuthorityMsgTx] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")], messageTransmitterId
      );

      // ==== PDAs on TokenMessengerMinterV2 ====
      const [tokenMessengerConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_messenger")], tokenMessengerMinterId
      );
      const [tokenMinter] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_minter")], tokenMessengerMinterId
      );
      const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
        [Buffer.from("remote_token_messenger"), Buffer.from(String(sourceDomain))], tokenMessengerMinterId
      );
      const [localToken] = PublicKey.findProgramAddressSync(
        [Buffer.from("local_token"), usdcMint.toBytes()], tokenMessengerMinterId
      );
      const [custodyAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("custody"), usdcMint.toBytes()], tokenMessengerMinterId
      );
      const [eventAuthorityTm] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")], tokenMessengerMinterId
      );

      // Fetch TokenMessenger config to get fee_recipient
      const tmConfigInfo = await connection.getAccountInfo(tokenMessengerConfig);
      if (!tmConfigInfo) {
        return { success: false, message: "TokenMessenger config PDA not found on devnet" };
      }
      const feeRecipient = new PublicKey(tmConfigInfo.data.slice(109, 141));

      const [feeRecipientAta] = PublicKey.findProgramAddressSync(
        [feeRecipient.toBytes(), TOKEN_PROGRAM_ID.toBytes(), usdcMint.toBytes()],
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const recipientAta = await PublicKey.createWithSeed(solanaKeypair.publicKey, USDC_TEMP_SEED, TOKEN_PROGRAM_ID);

      // Token pair PDA: seeds [b"token_pair", domain_str, burn_token_bytes]
      const messageBody = messageBuffer.subarray(148);
      const burnTokenBytes = messageBody.subarray(4, 36);
      const [tokenPair] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_pair"), Buffer.from(String(sourceDomain)), burnTokenBytes],
        tokenMessengerMinterId
      );

      // ==== Build instruction data ====
      // Discriminator: sha256("global:receive_message")[:8]
      const discriminator = Buffer.from([38, 144, 127, 225, 31, 225, 238, 25]);
      const msgLenBuf = Buffer.alloc(4);
      msgLenBuf.writeUInt32LE(messageBuffer.length, 0);
      const attLenBuf = Buffer.alloc(4);
      attLenBuf.writeUInt32LE(attestationBuffer.length, 0);

      const dataBuffer = Buffer.concat([
        discriminator,
        msgLenBuf, messageBuffer,
        attLenBuf, attestationBuffer
      ]);

      // ==== Instruction accounts ====
      // receive_message declared accounts (MessageTransmitterV2 IDL: 9 accounts)
      // + remaining accounts for CPI into handle_receive_finalized_message (11 accounts)
      // = 20 accounts total
      const accounts = [
        // receive_message declared accounts
        { pubkey: solanaKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: solanaKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: authorityPda, isSigner: false, isWritable: false },
        { pubkey: messageTransmitterConfig, isSigner: false, isWritable: false },
        { pubkey: usedNonce, isSigner: false, isWritable: true },
        { pubkey: tokenMessengerMinterId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityMsgTx, isSigner: false, isWritable: false },
        { pubkey: messageTransmitterId, isSigner: false, isWritable: false },
        // Remaining accounts: CPI into handle_receive_finalized_message (authority_pda prepended by program)
        { pubkey: tokenMessengerConfig, isSigner: false, isWritable: false },
        { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
        { pubkey: tokenMinter, isSigner: false, isWritable: false },
        { pubkey: localToken, isSigner: false, isWritable: true },
        { pubkey: tokenPair, isSigner: false, isWritable: false },
        { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: custodyAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityTm, isSigner: false, isWritable: false },
        { pubkey: tokenMessengerMinterId, isSigner: false, isWritable: false },
      ];

      const instruction = new TransactionInstruction({
        programId: messageTransmitterId,
        keys: accounts.map(a => ({
          pubkey: a.pubkey,
          isSigner: a.isSigner,
          isWritable: a.isWritable
        })),
        data: dataBuffer
      });

      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction().add(instruction);
      tx.recentBlockhash = blockhash;
      tx.feePayer = solanaKeypair.publicKey;
      tx.sign(solanaKeypair);

      const txHash = await connection.sendRawTransaction(tx.serialize());
      console.log(`[CCTP] Solana receiveMessage tx: ${txHash}`);

      const confirmed = await connection.confirmTransaction(txHash, "confirmed");
      if (confirmed.value.err) {
        return { success: false, txHash, message: `Solana tx failed: ${JSON.stringify(confirmed.value.err)}` };
      }
      const receiveFeeLine = await solanaTransactionFeeLine({
        connection,
        label: "CCTP Solana receiveMessage",
        txHash,
        payer: "developer"
      });
      if (receiveFeeLine) feeLines.push(receiveFeeLine);

      return { success: true, txHash, setupTxHash, feeLines };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[CCTP] Solana receiveMessage error:", msg);
      return { success: false, message: msg };
    }
  }

  private async receiveOnStellar(
    dstChain: any,
    message: Hex,
    attestation: Hex
  ): Promise<{ success: boolean; txHash?: string; message?: string; feeLines?: FeeLineItem[] }> {
    try {
      const rpcUrl = process.env[dstChain.rpcEnv] ?? dstChain.rpcUrl;
      const server = new SorobanRpc.Server(rpcUrl);
      const stellarKeypair = loadStellarKeypair();
      const stellarAccount = await server.getAccount(stellarKeypair.publicKey());

      const cctpForwarderId = dstChain.circle?.cctp?.cctpForwarder;
      if (!cctpForwarderId) {
        return { success: false, message: "CctpForwarder contract not configured for Stellar." };
      }
      const forwarder = new Contract(cctpForwarderId);

      const messageBytes = Buffer.from(message.slice(2), "hex");
      const attestationBytes = Buffer.from(attestation.slice(2), "hex");

      const call = forwarder.call("mint_and_forward", xdr.ScVal.scvBytes(messageBytes), xdr.ScVal.scvBytes(attestationBytes));

      const fee = String(Number(BASE_FEE) * 100);

      let tx = new TransactionBuilder(stellarAccount, {
        fee,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(call)
        .setTimeout(300)
        .build();

      // Soroban transactions require simulation before sending (SDK v11+)
      tx = await server.prepareTransaction(tx);

      tx.sign(stellarKeypair);

      const sendResponse = await server.sendTransaction(tx);
      if (sendResponse.status === "PENDING" || sendResponse.status === "DUPLICATE") {
        const txHash = sendResponse.hash;
        console.log(`[CCTP] Stellar mint_and_forward submitted: ${txHash}`);

        let result = await server.getTransaction(txHash);
        let attempts = 0;
        while ((result.status === "NOT_FOUND") && attempts < 30) {
          await new Promise(r => setTimeout(r, 2000));
          result = await server.getTransaction(txHash);
          attempts++;
        }

        if (result.status === "SUCCESS") {
          const feeLine = await stellarStroopsFeeLine({
            label: "CCTP Stellar mint_and_forward",
            feeStroops: stellarFeeStroops(result, tx.fee),
            txHash,
            payer: "developer"
          });
          return { success: true, txHash, feeLines: [feeLine] };
        }
        return { success: false, txHash, message: `Stellar tx not confirmed: ${result.status}` };
      }

      return { success: false, message: `Stellar sendTransaction failed: ${sendResponse.errorResult?.toString() ?? sendResponse.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[CCTP] Stellar receiveMessage error:", msg);
      return { success: false, message: msg };
    }
  }
}

function isBridgeOnlyProtocol(protocol: string): boolean {
  return protocol.endsWith("_USDC_TRANSFER");
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64Le(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
}

function u32Le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function hexBytes32ToBuffer(value: Hex): Buffer {
  const buffer = Buffer.from(value.slice(2), "hex");
  if (buffer.length !== 32) {
    throw new Error(`Expected bytes32 hex value, got ${buffer.length} bytes.`);
  }
  return buffer;
}

function stellarFeeStroops(result: any, fallbackFee: string | number | bigint): bigint {
  const value = result?.feeCharged ?? result?.fee_charged ?? result?.fee;
  return BigInt(value ?? fallbackFee);
}

async function waitForStellarTransaction(server: SorobanRpc.Server, txHash: string, maxAttempts: number): Promise<any> {
  let result = await server.getTransaction(txHash);
  let attempts = 0;
  while (result.status === "NOT_FOUND" && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    result = await server.getTransaction(txHash);
    attempts++;
  }
  return result;
}

function loadSolanaKeypair(): Keypair {
  const path = env.solanaKeypairPath || process.env.SOLANA_KEYPAIR_PATH || "./keys/solana-devnet.json";
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadStellarKeypair(): StellarKeypair {
  const secret = env.stellarSecretKey || process.env.STELLAR_SECRET_KEY;
  if (!secret) throw new Error("STELLAR_SECRET_KEY not set in .env");
  return StellarKeypair.fromSecret(secret);
}

async function ensureStellarTrustline(
  server: SorobanRpc.Server,
  keypair: StellarKeypair,
  assetCode: string,
  assetIssuer: string
): Promise<void> {
  try {
    const account = await server.getAccount(keypair.publicKey());
    console.log(`[Stellar] Ensuring USDC trustline for ${keypair.publicKey()}...`);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({
        asset: new Asset(assetCode, assetIssuer),
      }))
      .setTimeout(300)
      .build();

    tx.sign(keypair);
    const sendResponse = await server.sendTransaction(tx);
    if (sendResponse.status === "PENDING" || sendResponse.status === "DUPLICATE") {
      const txHash = sendResponse.hash;
      let result = await server.getTransaction(txHash);
      let attempts = 0;
      while (result.status === "NOT_FOUND" && attempts < 30) {
        await new Promise(r => setTimeout(r, 2000));
        result = await server.getTransaction(txHash);
        attempts++;
      }
      if (result.status === "SUCCESS") {
        console.log(`[Stellar] USDC trustline ensured: ${txHash}`);
      } else {
        console.warn(`[Stellar] Trustline tx status: ${result.status}`);
      }
    }
  } catch (err) {
    // changeTrust for an existing trustline is a no-op, so this is safe to ignore
    console.log("[Stellar] Trustline check complete (may already exist).");
  }
}
