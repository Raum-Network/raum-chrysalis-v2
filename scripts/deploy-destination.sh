#!/usr/bin/env bash
set -euo pipefail
cd contracts
forge script script/DeployDestination.s.sol:DeployDestination --rpc-url "$1" --broadcast --verify=false
