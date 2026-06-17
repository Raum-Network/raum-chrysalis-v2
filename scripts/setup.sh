#!/usr/bin/env bash
set -euo pipefail
cp -n .env.example .env || true
pnpm install
forge install OpenZeppelin/openzeppelin-contracts OpenZeppelin/openzeppelin-contracts-upgradeable foundry-rs/forge-std || true
