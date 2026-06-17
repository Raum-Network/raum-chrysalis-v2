import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair as SolanaKeypair } from "@solana/web3.js";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");

function updateEnv(updates: Record<string, string>) {
  const envPath = resolve(rootDir, ".env");
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    // If .env doesn't exist, read from .env.example
    try {
      content = readFileSync(resolve(rootDir, ".env.example"), "utf8");
    } catch {
      content = "";
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  writeFileSync(envPath, content, "utf8");
}

async function main() {
  console.log("Generating fresh keys...");

  // 1. Generate EVM Keys
  const deployerKey = generatePrivateKey();
  const operatorKey = generatePrivateKey();
  const agentKey = generatePrivateKey();

  const deployerAcc = privateKeyToAccount(deployerKey);
  const operatorAcc = privateKeyToAccount(operatorKey);
  const agentAcc = privateKeyToAccount(agentKey);

  console.log("\nGenerated EVM Accounts:");
  console.log(`- Deployer Address: ${deployerAcc.address}`);
  console.log(`- Operator Address: ${operatorAcc.address}`);
  console.log(`- Agent Address:    ${agentAcc.address}`);

  // 2. Generate Solana Key
  const solanaKp = SolanaKeypair.generate();
  const solanaPub = solanaKp.publicKey.toBase58();
  const solanaSecretArray = Array.from(solanaKp.secretKey);
  
  // Write Solana key to keys/solana-devnet.json
  const keysDir = resolve(rootDir, "keys");
  // Ensure keys directory exists
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir);
    }
  } catch {}
  
  writeFileSync(resolve(keysDir, "solana-devnet.json"), JSON.stringify(solanaSecretArray), "utf8");
  console.log("\nGenerated Solana Account:");
  console.log(`- Public Key: ${solanaPub}`);
  console.log(`- Saved to keys/solana-devnet.json`);

  // 3. Generate Stellar Key
  const stellarKp = StellarKeypair.random();
  const stellarPub = stellarKp.publicKey();
  const stellarSecret = stellarKp.secret();

  console.log("\nGenerated Stellar Account:");
  console.log(`- Public Key: ${stellarPub}`);

  // 4. Update .env
  updateEnv({
    DEPLOYER_PRIVATE_KEY: deployerKey,
    OPERATOR_PRIVATE_KEY: operatorKey,
    AGENT_PRIVATE_KEY: agentKey,
    SOLANA_KEYPAIR_PATH: "./keys/solana-devnet.json",
    STELLAR_SECRET_KEY: stellarSecret
  });

  console.log("\nSuccessfully updated .env file with the generated keys!");
}

main().catch((err) => {
  console.error("Error generating keys:", err);
  process.exit(1);
});
