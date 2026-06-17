import "dotenv/config";

const apiUrl = process.env.API_URL ?? "http://localhost:8787";
const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? 30_000);

async function runOnce() {
  const balances = { ARC: 10, BASE_SEPOLIA: 80, ETHEREUM_SEPOLIA: 50, SOLANA_DEVNET: 25 };
  const res = await fetch(`${apiUrl}/agents/rebalance/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ balances })
  });
  const proposal = await res.json();
  console.log(new Date().toISOString(), "rebalance proposal", proposal);

  if (proposal.shouldRebalance && process.env.AGENT_DRY_RUN === "false") {
    const create = await fetch(`${apiUrl}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal.intent)
    });
    console.log("executed rebalance", await create.json());
  }
}

runOnce().catch(console.error);
setInterval(() => runOnce().catch(console.error), intervalMs);
