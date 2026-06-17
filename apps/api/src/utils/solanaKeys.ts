import { Keypair } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// repoRoot is 4 levels up: utils/ → src/ → api/ → apps/ → root
const repoRoot = resolve(here, "../../../..");

export function loadSolanaKeypair(): Keypair | undefined {
  // 1. Try to load from env variable (JSON array of numbers format)
  const privateKey = env.solanaPrivateKey || process.env.SOLANA_PRIVATE_KEY;
  if (privateKey) {
    try {
      const trimmed = privateKey.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const raw = JSON.parse(trimmed) as number[];
        return Keypair.fromSecretKey(Uint8Array.from(raw));
      }
    } catch (err) {
      console.error("[SolanaKeys] Failed to parse SOLANA_PRIVATE_KEY from environment:", err);
    }
  }

  // 2. Fall back to file path
  const configuredPath = env.solanaKeypairPath || process.env.SOLANA_KEYPAIR_PATH;
  if (configuredPath) {
    const candidates = isAbsolute(configuredPath)
      ? [configuredPath]
      : [resolve(process.cwd(), configuredPath), resolve(repoRoot, configuredPath)];
    const keypairPath = candidates.find((candidate) => existsSync(candidate));
    if (keypairPath) {
      try {
        const raw = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
        return Keypair.fromSecretKey(Uint8Array.from(raw));
      } catch (err) {
        console.error(`[SolanaKeys] Failed to parse keypair file at ${keypairPath}:`, err);
      }
    }
  }

  return undefined;
}
