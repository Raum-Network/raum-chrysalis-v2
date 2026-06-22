import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

const repoRoot = "/Users/madhurverma/Desktop/Raum/raum-chrysalis-v2";
const envPath = resolve(repoRoot, ".env");

function readEnvFile(path) {
  const raw = readFileSync(path, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function anchorDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(env) {
  const raw = env.SOLANA_PRIVATE_KEY;
  if (!raw) throw new Error("SOLANA_PRIVATE_KEY missing in .env");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

const env = readEnvFile(envPath);
const rpcUrl = env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const adapterProgramId = new PublicKey(env.SOLANA_MARINADE_ADAPTER_PROGRAM_ID || "BiFFicCD6nAnLBBbuf1kFE9h6cbd895e1kTzYRJHJWmm");
const marinadeProgramId = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const admin = loadKeypair(env);
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("marinade-config")], adapterProgramId);

function rpc(method, params) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  const payloadPath = "/tmp/marinade-rpc-payload.json";
  writeFileSync(payloadPath, body);
  const out = execFileSync("/bin/zsh", [
    "-lc",
    `curl -s -X POST -H 'Content-Type: application/json' --data-binary @${payloadPath} ${rpcUrl}`
  ], { encoding: "utf8" });
  unlinkSync(payloadPath);
  const parsed = JSON.parse(out);
  if (parsed.error) throw new Error(`${method} failed: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const existing = rpc("getAccountInfo", [configPda.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
const method = existing?.value ? "force_init" : "initialize";
const ix = new TransactionInstruction({
  programId: adapterProgramId,
  keys: [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([anchorDiscriminator(method), marinadeProgramId.toBuffer()]),
});

const { blockhash } = rpc("getLatestBlockhash", [{ commitment: "confirmed" }]).value;
const tx = new Transaction().add(ix);
tx.feePayer = admin.publicKey;
tx.recentBlockhash = blockhash;
tx.sign(admin);
const serialized = tx.serialize().toString("base64");
const sig = rpc("sendTransaction", [serialized, { encoding: "base64", preflightCommitment: "confirmed" }]);

for (let i = 0; i < 20; i++) {
  const status = rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]).value?.[0];
  if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
  await sleep(1500);
}

console.log(JSON.stringify({
  method,
  signature: sig,
  adapterProgramId: adapterProgramId.toBase58(),
  marinadeProgramId: marinadeProgramId.toBase58(),
  configPda: configPda.toBase58(),
  admin: admin.publicKey.toBase58(),
}, null, 2));
