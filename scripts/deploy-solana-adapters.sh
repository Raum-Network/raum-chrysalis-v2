#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../programs/solana"

anchor build
anchor deploy --program-name arc_solana_receipts
anchor deploy --program-name kamino_adapter
anchor deploy --program-name raydium_adapter
anchor deploy --program-name marinade_adapter
node ../../scripts/init-marinade-adapter.mjs

cat <<'MSG'

Solana programs deployed. Initialize adapters with your admin wallet:
  kamino_adapter.initialize(kamino_program, executor, permissionless)
  raydium_adapter.initialize(raydium_program, executor, permissionless)
  marinade_adapter.initialize(marinade_program)

Kamino Lend (klend) program id on mainnet/devnet:
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD

Update .env if deployed ids differ from Anchor.toml:
  SOLANA_KAMINO_ADAPTER_PROGRAM_ID=
  SOLANA_RAYDIUM_ADAPTER_PROGRAM_ID=
  SOLANA_MARINADE_ADAPTER_PROGRAM_ID=
  KAMINO_MAIN_MARKET=
MSG
