#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../programs/stellar"

cargo build --target wasm32-unknown-unknown --release

cat <<'MSG'

Stellar WASM artifacts built under programs/stellar/target/wasm32-unknown-unknown/release.
Deploy them with Stellar CLI, then initialize:
  aquarius_adapter.initialize(admin, router, executor, permissionless)
  aquarius_adapter.set_pool(admin, pool)
  blend_adapter.initialize(admin, pool, pool_factory, backstop, executor, permissionless)

Update .env:
  AQUARIUS_ADAPTER_CONTRACT_ID=
  AQUARIUS_ROUTER_CONTRACT_ID=
  AQUARIUS_POOL_CONTRACT_ID=
  BLEND_ADAPTER_CONTRACT_ID=
MSG
