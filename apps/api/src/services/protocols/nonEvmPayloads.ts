import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

export interface SolanaAdapterPayload {
  cpiDataBase64: string;
  remainingAccounts: Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }>;
}

export interface StellarAdapterPayload {
  argsXdr: string[];
}

type SolanaInstructionLike = {
  programId?: unknown;
  data?: unknown;
  keys?: unknown;
  accounts?: unknown;
};

const RAYDIUM_TAGS: Record<string, string[]> = {
  SwapBaseInput: ["global:swap_base_input"],
  SwapBaseOutput: ["global:swap_base_output"],
  Deposit: ["global:deposit"],
  Withdraw: ["global:withdraw"],
  InitializePool: ["global:initialize", "global:initialize_pool"]
};

const KAMINO_TAGS: Record<string, string[]> = {
  DepositReserveLiquidity: [
    "global:deposit_reserve_liquidity",
    "global:deposit_reserve_liquidity_and_obligation_collateral"
  ],
  WithdrawReserveLiquidity: [
    "global:withdraw_obligation_collateral_and_redeem_reserve_collateral",
    "global:redeem_reserve_collateral"
  ],
  BorrowObligationLiquidity: ["global:borrow_obligation_liquidity"],
  RepayObligationLiquidity: ["global:repay_obligation_liquidity"],
  RefreshReserve: ["global:refresh_reserve"],
  RefreshObligation: ["global:refresh_obligation"]
};

const MARINADE_TAGS: Record<string, string[]> = {
  Deposit: ["global:deposit"],
  LiquidUnstake: ["global:liquid_unstake"]
};

export function resolveSolanaAdapterPayload(input: {
  action: string;
  protocolProgramId: string;
  providedCpiDataBase64?: unknown;
  providedRemainingAccounts?: unknown;
  sdkInstruction?: unknown;
  instruction?: unknown;
  allowSyntheticTestPayload?: boolean;
}): SolanaAdapterPayload | undefined {
  const direct = normalizeDirectSolanaPayload(input.providedCpiDataBase64, input.providedRemainingAccounts);
  if (direct) {
    validateSolanaPayload(input.action, direct);
    return direct;
  }

  const instruction = findSolanaInstruction(input.sdkInstruction ?? input.instruction, input.protocolProgramId);
  if (instruction) {
    const programId = instruction.programId?.toBase58();
    if (programId !== input.protocolProgramId) {
      throw new Error(`SDK instruction targets ${programId}; expected protocol program ${input.protocolProgramId}.`);
    }
    const payload = {
      cpiDataBase64: Buffer.from(instruction.data).toString("base64"),
      remainingAccounts: instruction.keys.map(accountMetaToJson)
    };
    validateSolanaPayload(input.action, payload);
    return payload;
  }

  if (input.allowSyntheticTestPayload) {
    return syntheticSolanaPayload(input.action);
  }

  return undefined;
}

export function resolveStellarAdapterPayload(input: {
  argsXdr?: unknown;
  scVals?: unknown;
  args?: unknown;
}): StellarAdapterPayload | undefined {
  const direct = normalizeXdrArray(input.argsXdr);
  if (direct) return { argsXdr: direct };

  const scVals = normalizeScValArray(input.scVals);
  if (scVals) return { argsXdr: scVals.map((value) => value.toXDR("base64")) };

  const nativeArgs = normalizeNativeArgs(input.args);
  if (nativeArgs) return { argsXdr: nativeArgs.map((value) => nativeToScVal(value).toXDR("base64")) };

  return undefined;
}

export function validateSolanaPayload(action: string, payload: SolanaAdapterPayload): void {
  const cpiData = Buffer.from(payload.cpiDataBase64, "base64");
  if (cpiData.length < 8) throw new Error("Solana CPI data must include at least an 8-byte Anchor discriminator.");
  const allowed = [...(RAYDIUM_TAGS[action] ?? []), ...(KAMINO_TAGS[action] ?? []), ...(MARINADE_TAGS[action] ?? [])].map(anchorDiscriminator);
  if (!allowed.length) throw new Error(`Unsupported Solana adapter action: ${action}`);
  if (!allowed.some((tag) => tag.equals(cpiData.subarray(0, 8)))) {
    throw new Error(`CPI discriminator is not allowlisted for ${action}.`);
  }
  for (const account of payload.remainingAccounts) {
    new PublicKey(account.pubkey);
  }
}

function normalizeDirectSolanaPayload(cpiDataBase64: unknown, remainingAccounts: unknown): SolanaAdapterPayload | undefined {
  const data = typeof cpiDataBase64 === "string" && cpiDataBase64.trim() ? cpiDataBase64 : undefined;
  const accounts = normalizeRemainingAccounts(remainingAccounts);
  return data && accounts?.length ? { cpiDataBase64: data, remainingAccounts: accounts } : undefined;
}

function findSolanaInstruction(value: unknown, protocolProgramId: string): TransactionInstruction | undefined {
  const expected = new PublicKey(protocolProgramId);
  const instructions = normalizeSolanaInstructions(value);
  if (!instructions.length) return undefined;
  return instructions.find((instruction) => instruction.programId.equals(expected)) ?? instructions[0];
}

function normalizeSolanaInstructions(value: unknown): TransactionInstruction[] {
  if (Array.isArray(value)) return value.flatMap(normalizeSolanaInstructions);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["instructions", "allInstructions"]) {
      if (Array.isArray(record[key])) return normalizeSolanaInstructions(record[key]);
    }
    const transaction = record.transaction as Record<string, unknown> | undefined;
    if (transaction?.instructions && Array.isArray(transaction.instructions)) {
      return normalizeSolanaInstructions(transaction.instructions);
    }
  }
  const instruction = normalizeSolanaInstruction(value);
  return instruction ? [instruction] : [];
}

function normalizeSolanaInstruction(value: unknown): TransactionInstruction | undefined {
  if (value instanceof TransactionInstruction) return value;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as SolanaInstructionLike;
  const programId = normalizePublicKey(candidate.programId);
  const data = normalizeBytes(candidate.data);
  const keys = normalizeAccountMetas(candidate.keys ?? candidate.accounts);
  if (!programId || !data || !keys?.length) return undefined;
  return new TransactionInstruction({ programId, data, keys });
}

function normalizePublicKey(value: unknown): PublicKey | undefined {
  if (value instanceof PublicKey) return value;
  if (typeof value === "string" && value.trim()) return new PublicKey(value);
  if (value && typeof value === "object" && "toBase58" in value && typeof value.toBase58 === "function") {
    return new PublicKey(value.toBase58());
  }
  return undefined;
}

function normalizeBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Buffer.from(value);
  }
  if (typeof value === "string" && value.trim()) {
    const normalized = value.startsWith("0x") ? value.slice(2) : value;
    if (/^[0-9a-fA-F]+$/.test(normalized) && normalized.length % 2 === 0) return Buffer.from(normalized, "hex");
    return Buffer.from(value, "base64");
  }
  return undefined;
}

function normalizeAccountMetas(value: unknown): AccountMeta[] | undefined {
  const accounts = normalizeRemainingAccounts(value);
  return accounts?.map((account) => ({
    pubkey: new PublicKey(account.pubkey),
    isWritable: account.isWritable,
    isSigner: account.isSigner
  }));
}

function normalizeRemainingAccounts(value: unknown): SolanaAdapterPayload["remainingAccounts"] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Solana remaining account must be an object.");
    const record = item as Record<string, unknown>;
    const pubkey = normalizePublicKey(record.pubkey ?? record.publicKey ?? record.address)?.toBase58();
    if (!pubkey) throw new Error("Solana remaining account is missing pubkey.");
    return {
      pubkey,
      isWritable: Boolean(record.isWritable ?? record.writable),
      isSigner: Boolean(record.isSigner ?? record.signer)
    };
  });
}

function accountMetaToJson(account: AccountMeta): SolanaAdapterPayload["remainingAccounts"][number] {
  return {
    pubkey: account.pubkey.toBase58(),
    isWritable: account.isWritable,
    isSigner: account.isSigner
  };
}

function normalizeXdrArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const xdrs = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error("Soroban argsXdr entries must be base64 strings.");
    xdr.ScVal.fromXDR(item, "base64");
    return item;
  });
  return xdrs;
}

function normalizeScValArray(value: unknown): xdr.ScVal[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    if (item instanceof xdr.ScVal) return item;
    if (typeof item === "string") return xdr.ScVal.fromXDR(item, "base64");
    throw new Error("Soroban scVals entries must be ScVal objects or base64 XDR strings.");
  });
}

function normalizeNativeArgs(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function syntheticSolanaPayload(action: string): SolanaAdapterPayload {
  const tags = RAYDIUM_TAGS[action] ?? KAMINO_TAGS[action] ?? MARINADE_TAGS[action];
  if (!tags?.length) throw new Error(`Unsupported synthetic Solana action: ${action}`);
  return {
    cpiDataBase64: Buffer.concat([anchorDiscriminator(tags[0]), Buffer.alloc(8)]).toString("base64"),
    remainingAccounts: [{ pubkey: PublicKey.default.toBase58(), isWritable: false, isSigner: false }]
  };
}

function anchorDiscriminator(tag: string): Buffer {
  return createHash("sha256").update(tag).digest().subarray(0, 8);
}
