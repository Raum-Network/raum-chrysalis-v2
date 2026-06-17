import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  Transaction,
  TransactionInstruction,
  type AccountMeta
} from "@solana/web3.js";
import {
  AccountLayout,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { env, findChainByKey } from "../../config/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");

export interface SolanaAdapterSubmitInput {
  protocol: "raydium" | "kamino" | "marinade";
  adapterProgramId: string;
  protocolProgramId: string;
  intentId: string;
  actionIndex: number;
  amount: bigint;
  limitAmount?: bigint;
  cpiDataBase64: string;
  remainingAccounts: Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }>;
  memo: string;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}

export interface SolanaSimulationResult {
  unitsConsumed: number;
  feeLamports: bigint;
  logs?: string[];
  adapterProgramId: string;
  receiptPda?: string;
  amountOut?: string;
  amountOutSymbol?: string;
}

export async function submitSolanaAdapter(input: SolanaAdapterSubmitInput): Promise<{
  signature: string;
  receiptPda: string;
  adapterProgramId: string;
  feeLamports?: string;
}> {
  const chain = findChainByKey("SOLANA_DEVNET");
  const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
  const connection = new Connection(rpcUrl, "confirmed");
  const authority = loadSolanaKeypair();

  const adapterProgram = new PublicKey(input.adapterProgramId);
  const protocolProgram = new PublicKey(input.protocolProgramId);
  const intentBytes = intentIdBytes(input.intentId);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from(`${input.protocol}-config`)], adapterProgram);
  const [receiptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(`${input.protocol}-receipt`), intentBytes],
    adapterProgram
  );

  const existingReceipt = await connection.getAccountInfo(receiptPda, "confirmed");
  if (existingReceipt) {
    return {
      signature: "",
      receiptPda: receiptPda.toBase58(),
      adapterProgramId: adapterProgram.toBase58()
    };
  }

  const transaction = buildExecuteTransaction({
    input,
    adapterProgram,
    protocolProgram,
    authority,
    receiptPda
  });
  const signature = await sendAndConfirmTransaction(connection, transaction, [authority], {
    commitment: "confirmed",
    maxRetries: 3
  });

  return {
    signature,
    receiptPda: receiptPda.toBase58(),
    adapterProgramId: adapterProgram.toBase58(),
    feeLamports: (await confirmedFeeLamports(connection, signature))?.toString()
  };
}

export async function simulateSolanaAdapter(input: SolanaAdapterSubmitInput): Promise<SolanaSimulationResult> {
  const chain = findChainByKey("SOLANA_DEVNET");
  const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
  const connection = new Connection(rpcUrl, "confirmed");
  const authority = loadSolanaKeypair();
  const adapterProgram = new PublicKey(input.adapterProgramId);
  const protocolProgram = new PublicKey(input.protocolProgramId);
  const intentBytes = intentIdBytes(input.intentId || "simulation");
  const [receiptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(`${input.protocol}-receipt`), intentBytes],
    adapterProgram
  );
  const transaction = buildExecuteTransaction({
    input,
    adapterProgram,
    protocolProgram,
    authority,
    receiptPda
  });
  return simulateBuiltTransaction(connection, transaction, [authority], {
    adapterProgramId: adapterProgram.toBase58(),
    receiptPda: receiptPda.toBase58(),
    computeUnitPriceMicroLamports: input.computeUnitPriceMicroLamports
  });
}

function buildExecuteTransaction(input: {
  input: SolanaAdapterSubmitInput;
  adapterProgram: PublicKey;
  protocolProgram: PublicKey;
  authority: Keypair;
  receiptPda: PublicKey;
}): Transaction {
  const { adapterProgram, protocolProgram, authority, receiptPda } = input;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from(`${input.input.protocol}-config`)], adapterProgram);
  const keys: AccountMeta[] = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: protocolProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...input.input.remainingAccounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable
    }))
  ];

  const instructions: TransactionInstruction[] = [];
  if (input.input.computeUnitLimit) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: input.input.computeUnitLimit }));
  }
  if (input.input.computeUnitPriceMicroLamports) {
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.input.computeUnitPriceMicroLamports }));
  }
  instructions.push(new TransactionInstruction({
    programId: adapterProgram,
    keys,
    data: encodeExecuteData(input.input)
  }));

  return new Transaction().add(...instructions);
}

function encodeExecuteData(input: SolanaAdapterSubmitInput): Buffer {
  const cpiData = Buffer.from(input.cpiDataBase64, "base64");
  const memo = Buffer.from(input.memo, "utf8");
  const amount = encodeU64(input.amount);
  const parts = [
    anchorDiscriminator("execute"),
    intentIdBytes(input.intentId),
    Buffer.from([input.actionIndex]),
    amount
  ];

  if (input.protocol === "raydium" || input.protocol === "marinade") {
    parts.push(encodeU64(input.limitAmount ?? 0n));
  }

  parts.push(encodeVec(cpiData), encodeVec(memo));
  return Buffer.concat(parts);
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeU64(value: bigint): Buffer {
  if (value < 0n || value > 2n ** 64n - 1n) throw new Error(`u64 out of range: ${value}`);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function encodeVec(value: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(value.length);
  return Buffer.concat([len, value]);
}

function intentIdBytes(intentId: string): Buffer {
  const normalized = intentId.startsWith("0x") ? intentId.slice(2) : intentId;
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return Buffer.from(normalized, "hex");
  return createHash("sha256").update(intentId).digest();
}

function loadSolanaKeypair(): Keypair {
  const configuredPath = env.solanaKeypairPath;
  const candidates = isAbsolute(configuredPath)
    ? [configuredPath]
    : [resolve(repoRoot, configuredPath), resolve(process.cwd(), configuredPath)];

  const keypairPath = candidates.find((candidate) => existsSync(candidate));
  if (!keypairPath) throw new Error(`Solana keypair not found at ${configuredPath}`);

  const raw = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// --- Marinade deposit_with_swap (composite: USDC → wSOL → native SOL → mSOL) ---

export interface MarinadeDepositWithSwapInput {
  adapterProgramId: string;
  marinadeProgramId: string;
  raydiumProgramId: string;
  swapAmount: bigint;
  minOutAmount: bigint;
  depositAmount: bigint;
  remainingAccounts: Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }>;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  msolRecipient?: string;
}

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");

export async function submitMarinadeDepositWithSwap(input: MarinadeDepositWithSwapInput): Promise<{
  signature: string;
  adapterProgramId: string;
  feeLamports?: string;
}> {
  const chain = findChainByKey("SOLANA_DEVNET");
  const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
  const connection = new Connection(rpcUrl, "confirmed");
  const authority = loadSolanaKeypair();

  const built = await buildMarinadeDepositWithSwapTransaction(connection, input, authority);
  const signature = await sendAndConfirmV0Transaction(connection, built.transaction, [authority]);

  return {
    signature,
    adapterProgramId: built.adapterProgram.toBase58(),
    feeLamports: (await confirmedFeeLamports(connection, signature))?.toString()
  };
}

export async function simulateMarinadeDepositWithSwap(input: MarinadeDepositWithSwapInput): Promise<SolanaSimulationResult> {
  const chain = findChainByKey("SOLANA_DEVNET");
  const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
  const connection = new Connection(rpcUrl, "confirmed");
  const authority = loadSolanaKeypair();

  const built = await buildMarinadeDepositWithSwapTransaction(connection, input, authority);
  return simulateBuiltV0Transaction(connection, built.transaction, [authority], {
    adapterProgramId: built.adapterProgram.toBase58(),
    computeUnitPriceMicroLamports: input.computeUnitPriceMicroLamports,
    trackedTokenAccount: built.msolAccount,
    trackedPreTokenAmount: built.msolPreAmount,
    trackedTokenSymbol: "mSOL"
  });
}

async function buildMarinadeDepositWithSwapTransaction(
  connection: Connection,
  input: MarinadeDepositWithSwapInput,
  authority: Keypair
): Promise<{
  transaction: Transaction;
  adapterProgram: PublicKey;
  msolAccount: PublicKey;
  msolPreAmount: bigint;
}> {
  const adapterProgram = new PublicKey(input.adapterProgramId);
  const marinadeProgram = new PublicKey(input.marinadeProgramId);
  const raydiumProgram = new PublicKey(input.raydiumProgramId);
  const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("marinade-config")],
    adapterProgram,
  );

  const msolRecipient = input.msolRecipient ? new PublicKey(input.msolRecipient) : authority.publicKey;
  const usdcAccount = getAssociatedTokenAddressSync(USDC_MINT, authority.publicKey, false, tokenProgram);
  const wsolAccount = getAssociatedTokenAddressSync(WSOL_MINT, authority.publicKey, false, tokenProgram);
  const msolAccount = getAssociatedTokenAddressSync(MSOL_MINT, msolRecipient, false, tokenProgram);

  const usdcInfo = await connection.getAccountInfo(usdcAccount, "confirmed");
  if (!usdcInfo) {
    throw new Error(`Solana USDC associated token account is missing: ${usdcAccount.toBase58()}. Fund it before executing Marinade.`);
  }

  const remainingAccounts = input.remainingAccounts.slice();
  remainingAccounts[4] = { pubkey: usdcAccount.toBase58(), isWritable: true, isSigner: false };
  remainingAccounts[5] = { pubkey: wsolAccount.toBase58(), isWritable: true, isSigner: false };
  remainingAccounts[20] = { pubkey: msolAccount.toBase58(), isWritable: true, isSigner: false };

  const instructions: TransactionInstruction[] = [];
  if (input.computeUnitLimit) instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }));
  if (input.computeUnitPriceMicroLamports) instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.computeUnitPriceMicroLamports }));

  const existingWsol = await connection.getAccountInfo(wsolAccount, "confirmed");
  if (!existingWsol) {
    instructions.push(createAssociatedTokenAccountInstruction(
      authority.publicKey,
      wsolAccount,
      authority.publicKey,
      WSOL_MINT,
      tokenProgram
    ));
  }

  const existingMsol = await connection.getAccountInfo(msolAccount, "confirmed");
  const msolPreAmount = existingMsol ? decodeTokenAccountAmount(existingMsol.data) : 0n;
  if (!existingMsol) {
    instructions.push(createAssociatedTokenAccountInstruction(
      authority.publicKey,
      msolAccount,
      msolRecipient,
      MSOL_MINT,
      tokenProgram
    ));
  }

  const keys: AccountMeta[] = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: marinadeProgram, isSigner: false, isWritable: false },
    { pubkey: raydiumProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...remainingAccounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
  ];
  instructions.push(new TransactionInstruction({
    programId: adapterProgram,
    keys,
    data: Buffer.concat([
      anchorDiscriminator("deposit_with_swap"),
      encodeU64(input.swapAmount),
      encodeU64(input.minOutAmount),
      encodeU64(input.depositAmount)
    ]),
  }));

  return {
    transaction: new Transaction().add(...instructions),
    adapterProgram,
    msolAccount,
    msolPreAmount
  };
}

async function simulateBuiltTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  metadata: { adapterProgramId: string; receiptPda?: string; computeUnitPriceMicroLamports?: number }
): Promise<SolanaSimulationResult> {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = signers[0].publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(...signers);
  const result = await connection.simulateTransaction(transaction, signers);
  if (result.value.err) {
    const logs = result.value.logs ?? [];
    throw new Error(`Solana simulation failed: ${JSON.stringify(result.value.err)}${logs.length ? `; logs: ${logs.slice(-6).join(" | ")}` : ""}`);
  }
  const message = transaction.compileMessage();
  const fee = await connection.getFeeForMessage(message, "confirmed");
  const unitsConsumed = result.value.unitsConsumed ?? 0;
  const priorityFeeLamports = metadata.computeUnitPriceMicroLamports
    ? BigInt(Math.ceil((unitsConsumed * metadata.computeUnitPriceMicroLamports) / 1_000_000))
    : 0n;
  return {
    unitsConsumed,
    feeLamports: BigInt(fee.value ?? 5000) + priorityFeeLamports,
    logs: result.value.logs ?? [],
    adapterProgramId: metadata.adapterProgramId,
    receiptPda: metadata.receiptPda
  };
}

async function simulateBuiltV0Transaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  metadata: {
    adapterProgramId: string;
    computeUnitPriceMicroLamports?: number;
    trackedTokenAccount?: PublicKey;
    trackedPreTokenAmount?: bigint;
    trackedTokenSymbol?: string;
  }
): Promise<SolanaSimulationResult> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: latest.blockhash,
    instructions: transaction.instructions
  }).compileToV0Message();
  const versioned = new VersionedTransaction(message);
  versioned.sign(signers);
  const result = await connection.simulateTransaction(versioned, {
    sigVerify: false,
    accounts: metadata.trackedTokenAccount
      ? { encoding: "base64", addresses: [metadata.trackedTokenAccount.toBase58()] }
      : undefined
  });
  if (result.value.err) {
    const logs = result.value.logs ?? [];
    throw new Error(`Solana simulation failed: ${JSON.stringify(result.value.err)}${logs.length ? `; logs: ${logs.slice(-8).join(" | ")}` : ""}`);
  }
  const fee = await connection.getFeeForMessage(message, "confirmed");
  const unitsConsumed = result.value.unitsConsumed ?? 0;
  const priorityFeeLamports = metadata.computeUnitPriceMicroLamports
    ? BigInt(Math.ceil((unitsConsumed * metadata.computeUnitPriceMicroLamports) / 1_000_000))
    : 0n;
  const postAmount = result.value.accounts?.[0]?.data
    ? decodeTokenAccountAmount(Buffer.from(result.value.accounts[0].data[0], "base64"))
    : undefined;
  const amountOut = postAmount === undefined
    ? undefined
    : postAmount > (metadata.trackedPreTokenAmount ?? 0n)
      ? postAmount - (metadata.trackedPreTokenAmount ?? 0n)
      : 0n;
  return {
    unitsConsumed,
    feeLamports: BigInt(fee.value ?? 5000) + priorityFeeLamports,
    logs: result.value.logs ?? [],
    adapterProgramId: metadata.adapterProgramId,
    amountOut: amountOut?.toString(),
    amountOutSymbol: amountOut === undefined ? undefined : metadata.trackedTokenSymbol
  };
}

async function sendAndConfirmV0Transaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[]
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: latest.blockhash,
    instructions: transaction.instructions
  }).compileToV0Message();
  const versioned = new VersionedTransaction(message);
  versioned.sign(signers);
  const signature = await connection.sendTransaction(versioned, { maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  }, "confirmed");
  if (confirmation.value.err) {
    throw new Error(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

async function confirmedFeeLamports(connection: Connection, signature: string): Promise<bigint | undefined> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0
  });
  return tx?.meta?.fee === undefined || tx.meta.fee === null ? undefined : BigInt(tx.meta.fee);
}

function decodeTokenAccountAmount(data: Buffer): bigint {
  return AccountLayout.decode(data).amount;
}
