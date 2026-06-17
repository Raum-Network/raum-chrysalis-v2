import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const protocols = JSON.parse(readFileSync(resolve(process.cwd(), "configs/protocols.json"), "utf8"));

console.log("Adapter registration plan");
for (const [chain, items] of Object.entries(protocols as any)) {
  for (const item of items as any[]) {
    console.log(`${chain}:${item.key} -> ${item.adapter}`);
  }
}
console.log("\nUse contracts/script/Deploy*.s.sol for onchain deployment, then call registerAdapter for newly deployed adapters.");
