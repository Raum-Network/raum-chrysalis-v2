// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VerifiedTargetAdapter} from "./VerifiedTargetAdapter.sol";

contract GatewayWalletAdapter is VerifiedTargetAdapter {
    constructor(address router_, address admin)
        VerifiedTargetAdapter(router_, keccak256("ARC_GATEWAY_WALLET_ADAPTER"), "Circle Gateway Wallet", admin)
    {}
}
