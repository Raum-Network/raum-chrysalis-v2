#!/usr/bin/env bash
set -euo pipefail
cd contracts
forge script script/DeployArc.s.sol:DeployArc --rpc-url "$ARC_RPC_URL" --broadcast --verify=false
