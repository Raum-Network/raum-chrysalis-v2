import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

async function fundSolana(address: string) {
  console.log(`Requesting Solana Devnet airdrop for ${address}...`);
  try {
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    const publicKey = new PublicKey(address);
    const signature = await connection.requestAirdrop(publicKey, 1 * LAMPORTS_PER_SOL);
    
    // Wait for confirmation
    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature
    });
    console.log("Solana Devnet airdrop successful!");
  } catch (err) {
    console.error("Solana Devnet airdrop failed:", err instanceof Error ? err.message : String(err));
    console.log("Please request test SOL manually at: https://faucet.solana.com/");
  }
}

async function fundStellar(address: string) {
  console.log(`Requesting Stellar Testnet funding for ${address}...`);
  try {
    const url = `https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`;
    const res = await fetch(url);
    if (res.ok) {
      console.log("Stellar Testnet funding successful via Friendbot!");
    } else {
      console.error("Stellar Testnet funding failed with status:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Stellar Testnet funding failed:", err);
  }
}

async function main() {
  const solanaAddress = "93ybLFq5KvHogjDjSxnwnWxKWRY3iSyZyGy6wkRPYHUi";
  const stellarAddress = "GDQRVBRO5CGIY6DT4MFYIE7LP2QPYGMMYQN5AHJ4CZE3MAQASHXH46B6";

  await fundSolana(solanaAddress);
  await fundStellar(stellarAddress);
}

main().catch((err) => {
  console.error("Error funding accounts:", err);
  process.exit(1);
});
