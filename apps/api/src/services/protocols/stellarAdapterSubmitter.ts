import { createHash } from "node:crypto";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc
} from "@stellar/stellar-sdk";
import { Spec as ContractSpec } from "@stellar/stellar-sdk/contract";
import { env, findChainByKey } from "../../config/index.js";

const AQUARIUS_SPEC = new ContractSpec([
  "AAAAAgAAAAAAAAAAAAAADkFxdWFyaXVzQWN0aW9uAAAAAAAEAAAAAAAAAAAAAAALU3dhcENoYWluZWQAAAAAAAAAAAAAAAAYU3dhcENoYWluZWRTdHJpY3RSZWNlaXZlAAAAAAAAAAAAAAAHRGVwb3NpdAAAAAAAAAAAAAAAAAhXaXRoZHJhdw==",
  "AAAAAQAAAAAAAAAAAAAAC1JlbGF5UGFyYW1zAAAAAAIAAAAAAAAACXJlY2lwaWVudAAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEw==",
  "AAAAAAAAAPhFeGVjdXRlcyBhbiBBcXVhcml1cyByb3V0ZXIgY2FsbCBhZnRlciB2YWxpZGF0aW5nIHRoZSB0YXJnZXQgY29udHJhY3QgYW5kIG1ldGhvZC4KClRoZSBBcmMgT1MgZXhlY3V0b3IgYnVpbGRzIHRoZSBTb3JvYmFuIGFyZ3VtZW50IHZlY3RvciBmcm9tIGxpdmUgQXF1YXJpdXMgcGF0aC1maW5kaW5nLgpUaGlzIGFkYXB0ZXIgb25seSBlbmZvcmNlcyBwb2xpY3kgYW5kIHJlY29yZHMgdGhlIGNyb3NzLWNoYWluIGludGVudCByZWNlaXB0LgAAAAdleGVjdXRlAAAAAAoAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJaW50ZW50X2lkAAAAAAAD7gAAACAAAAAAAAAABmFjdGlvbgAAAAAH0AAAAA5BcXVhcml1c0FjdGlvbgAAAAAAAAAAAAZ0YXJnZXQAAAAAABMAAAAAAAAABm1ldGhvZAAAAAAAEQAAAAAAAAAEYXJncwAAA+oAAAAAAAAAAAAAAAlhbW91bnRfaW4AAAAAAAALAAAAAAAAAA5taW5fYW1vdW50X291dAAAAAAACwAAAAAAAAAEbWVtbwAAABAAAAAAAAAABXJlbGF5AAAAAAAD6AAAB9AAAAALUmVsYXlQYXJhbXMAAAAAAQAAAAA="
]);

const BLEND_SPEC = new ContractSpec([
  "AAAAAgAAAAAAAAAAAAAAC0JsZW5kQWN0aW9uAAAAAAgAAAAAAAAAAAAAAAZTdXBwbHkAAAAAAAAAAAAAAAAACFdpdGhkcmF3AAAAAAAAAAAAAAAGQm9ycm93AAAAAAAAAAAAAAAAAAVSZXBheQAAAAAAAAAAAAAAAAAABUNsYWltAAAAAAAAAAAAAAAAAAAPQmFja3N0b3BEZXBvc2l0AAAAAAAAAAAAAAAAF0JhY2tzdG9wUXVldWVXaXRoZHJhd2FsAAAAAAAAAAAAAAAAEEJhY2tzdG9wV2l0aGRyYXc=",
  "AAAAAQAAAAAAAAAAAAAAC1JlbGF5UGFyYW1zAAAAAAIAAAAAAAAACXJlY2lwaWVudAAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEw==",
  "AAAAAAAAAYZFeGVjdXRlcyBhIEJsZW5kIHBvb2wvYmFja3N0b3AgY2FsbCBhZnRlciB2YWxpZGF0aW5nIHRhcmdldCBhbmQgbWV0aG9kLgoKQmxlbmQgdjIgdXNlciBhY3Rpb25zIGdlbmVyYWxseSBmbG93IHRocm91Z2ggYSBwb29sIHN1Ym1pdC1zdHlsZSBjYWxsIHdpdGggYSB2ZWN0b3IKb2YgcmVxdWVzdHMuIFRoZSBBUEkvYWdlbnQgYnVpbGRzIHRoYXQgdHlwZWQgcmVxdWVzdCB2ZWN0b3IgYW5kIHBhc3NlcyBpdCBpbiBgYXJnc2AuClRoZSBhZGFwdGVyIGlzIGludGVudGlvbmFsbHkgdGhpbjogaXQgZ2F0ZXMgYWxsb3dlZCBCbGVuZCBlbnRyeXBvaW50cywgaW52b2tlcyB0aGUKY29uZmlndXJlZCBwb29sL2JhY2tzdG9wIGNvbnRyYWN0LCBhbmQgcmVjb3JkcyBhbiBBcmMgT1MgcmVjZWlwdC4AAAAAAAdleGVjdXRlAAAAAAkAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJaW50ZW50X2lkAAAAAAAD7gAAACAAAAAAAAAABmFjdGlvbgAAAAAH0AAAAAtCbGVuZEFjdGlvbgAAAAAAAAAABnRhcmdldAAAAAAAEwAAAAAAAAAGbWV0aG9kAAAAAAARAAAAAAAAAARhcmdzAAAD6gAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAEbWVtbwAAABAAAAAAAAAABXJlbGF5AAAAAAAD6AAAB9AAAAALUmVsYXlQYXJhbXMAAAAAAQAAAAA="
]);

export interface StellarAdapterSubmitInput {
  protocol: "aquarius" | "blend";
  adapterContractId: string;
  targetContractId: string;
  targetMethod: string;
  intentId: string;
  action: string;
  argsXdr: string[];
  amount: bigint;
  minAmountOut?: bigint;
  memo: string;
  relay?: { recipient: string; token: string };
  directMethod?: string;
}

export interface StellarSimulationResult {
  minResourceFeeStroops: bigint;
  amountOut?: string;
  result?: string;
  cost?: unknown;
  latestLedger?: number;
}

export async function simulateStellarAdapter(input: StellarAdapterSubmitInput): Promise<StellarSimulationResult> {
  const { server, keypair, source } = await stellarContext();
  const transaction = buildStellarAdapterTransaction(input, source, keypair.publicKey());
  const simulated = await (server as any).simulateTransaction(transaction);
  if (simulated?.error) {
    throw new Error(`Stellar simulation failed: ${simulated.error}`);
  }
  if (simulated?.result?.auth || simulated?.transactionData) {
    const fee = BigInt(simulated.minResourceFee ?? simulated.cost?.fee ?? 0);
    const returnValue = simulated.result?.retval;
    const amountOut = amountFromReturnValue(returnValue);
    return {
      minResourceFeeStroops: fee,
      amountOut: amountOut > 0n ? amountOut.toString() : undefined,
      result: returnValue?.toXDR?.("base64"),
      cost: simulated.cost,
      latestLedger: simulated.latestLedger
    };
  }
  const prepared = await server.prepareTransaction(transaction);
  return {
    minResourceFeeStroops: BigInt(prepared.fee),
    latestLedger: undefined
  };
}

export async function submitStellarAdapter(input: StellarAdapterSubmitInput): Promise<{
  hash: string;
  adapterContractId: string;
  relayHash?: string;
  feeStroops?: string;
  relayFeeStroops?: string;
  amountOut?: string;
}> {
  const { server, keypair, source } = await stellarContext();
  const scArgs = input.argsXdr.map((arg) => xdr.ScVal.fromXDR(arg, "base64"));

  if (input.directMethod) {
    const contract = new Contract(input.adapterContractId);
    let transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET
    })
      .addOperation(contract.call(input.directMethod, ...scArgs))
      .setTimeout(300)
      .build();
    transaction = await server.prepareTransaction(transaction);
    transaction.sign(keypair);
    const sent = await server.sendTransaction(transaction);
    if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      throw new Error(`Stellar transaction submission failed: ${sent.status} ${sent.errorResult ?? ""}`.trim());
    }
    const hash = sent.hash;
    const final = await waitForStellarResult(server, hash);
    if (final.status !== "SUCCESS") {
      throw new Error(`Stellar transaction failed: ${final.status} ${final.resultXdr ?? ""}`.trim());
    }
    const amountOut = amountFromReturnValue(final.returnValue);
    const relay = input.relay && amountOut > 0n
      ? await submitTokenRelay({
          server,
          sourceKeypair: keypair,
          token: input.relay.token,
          recipient: input.relay.recipient,
          amount: amountOut
        })
      : undefined;
    return {
      hash,
      adapterContractId: input.adapterContractId,
      relayHash: relay?.hash,
      feeStroops: stellarFeeStroops(final, transaction.fee)?.toString(),
      relayFeeStroops: relay?.feeStroops,
      amountOut: amountOut.toString()
    };
  }

  let transaction = buildStellarAdapterTransaction(input, source, keypair.publicKey());

  transaction = await server.prepareTransaction(transaction);
  transaction.sign(keypair);

  const sent = await server.sendTransaction(transaction);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`Stellar transaction submission failed: ${sent.status} ${sent.errorResult ?? ""}`.trim());
  }

  const hash = sent.hash;
  const final = await waitForStellarResult(server, hash);
  if (final.status !== "SUCCESS") {
    throw new Error(`Stellar transaction failed: ${final.status} ${final.resultXdr ?? ""}`.trim());
  }

  return {
    hash,
    adapterContractId: input.adapterContractId,
    feeStroops: stellarFeeStroops(final, transaction.fee)?.toString()
  };
}

async function stellarContext(): Promise<{ server: rpc.Server; keypair: Keypair; source: any }> {
  if (!env.stellarSecretKey) throw new Error("STELLAR_SECRET_KEY is not set.");
  const chain = findChainByKey("STELLAR_TESTNET");
  const rpcUrl = process.env[chain.rpcEnv] ?? chain.rpcUrl;
  const server = new rpc.Server(rpcUrl);
  const keypair = Keypair.fromSecret(env.stellarSecretKey);
  const source = await server.getAccount(keypair.publicKey());
  return { server, keypair, source };
}

function buildStellarAdapterTransaction(input: StellarAdapterSubmitInput, source: any, caller: string) {
  const scArgs = input.argsXdr.map((arg) => xdr.ScVal.fromXDR(arg, "base64"));
  if (input.directMethod) {
    const contract = new Contract(input.adapterContractId);
    return new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET
    })
      .addOperation(contract.call(input.directMethod, ...scArgs))
      .setTimeout(300)
      .build();
  }

  const contract = new Contract(input.adapterContractId);
  const spec = input.protocol === "aquarius" ? AQUARIUS_SPEC : BLEND_SPEC;
  const args = input.protocol === "aquarius"
    ? spec.funcArgsToScVals("execute", {
        caller,
        intent_id: intentIdBytes(input.intentId),
        action: { tag: input.action, values: undefined },
        target: input.targetContractId,
        method: input.targetMethod,
        args: scArgs,
        amount_in: input.amount,
        min_amount_out: input.minAmountOut ?? 0n,
        memo: input.memo,
        relay: input.relay
      })
    : spec.funcArgsToScVals("execute", {
        caller,
        intent_id: intentIdBytes(input.intentId),
        action: { tag: input.action, values: undefined },
        target: input.targetContractId,
        method: input.targetMethod,
        args: scArgs,
        amount: input.amount,
        memo: input.memo,
        relay: input.relay
      });

  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(contract.call("execute", ...args))
    .setTimeout(300)
    .build();
}

async function waitForStellarResult(server: rpc.Server, hash: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await server.getTransaction(hash);
    if (result.status !== "NOT_FOUND") return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for Stellar transaction ${hash}`);
}

function intentIdBytes(intentId: string): Buffer {
  const normalized = intentId.startsWith("0x") ? intentId.slice(2) : intentId;
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return Buffer.from(normalized, "hex");
  return createHash("sha256").update(intentId).digest();
}

function amountFromReturnValue(value: xdr.ScVal | undefined): bigint {
  if (!value) return 0n;
  const native = scValToNative(value);
  if (typeof native === "bigint") return native;
  if (typeof native === "number" && Number.isFinite(native)) return BigInt(Math.floor(native));
  if (typeof native === "string" && /^[0-9]+$/.test(native)) return BigInt(native);
  return 0n;
}

async function submitTokenRelay(input: {
  server: rpc.Server;
  sourceKeypair: Keypair;
  token: string;
  recipient: string;
  amount: bigint;
}): Promise<{ hash: string; feeStroops?: string }> {
  const source = await input.server.getAccount(input.sourceKeypair.publicKey());
  const token = new Contract(input.token);
  let transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(token.call(
      "transfer",
      nativeToScVal(strkeyToAddress(input.sourceKeypair.publicKey())),
      nativeToScVal(strkeyToAddress(input.recipient)),
      nativeToScVal(input.amount, { type: "i128" })
    ))
    .setTimeout(300)
    .build();

  transaction = await input.server.prepareTransaction(transaction);
  transaction.sign(input.sourceKeypair);
  const sent = await input.server.sendTransaction(transaction);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`Stellar relay submission failed: ${sent.status} ${sent.errorResult ?? ""}`.trim());
  }
  const final = await waitForStellarResult(input.server, sent.hash);
  if (final.status !== "SUCCESS") {
    throw new Error(`Stellar relay failed: ${final.status} ${final.resultXdr ?? ""}`.trim());
  }
  return { hash: sent.hash, feeStroops: stellarFeeStroops(final, transaction.fee)?.toString() };
}

function stellarFeeStroops(final: any, fallbackFee: string | number | bigint): bigint | undefined {
  const value = final?.feeCharged ?? final?.fee_charged ?? final?.fee;
  if (value !== undefined && value !== null) return BigInt(value);
  return fallbackFee === undefined || fallbackFee === null ? undefined : BigInt(fallbackFee);
}

function strkeyToAddress(id: string): Address {
  if (id.startsWith("G")) {
    if (!StrKey.isValidEd25519PublicKey(id)) throw new Error(`Invalid Stellar account address: ${id}`);
    return new Address(id);
  }
  if (!StrKey.isValidContract(id)) throw new Error(`Invalid Stellar contract address: ${id}`);
  return Address.contract(StrKey.decodeContract(id));
}
