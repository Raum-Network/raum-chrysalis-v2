// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VerifiedTargetAdapter} from "./VerifiedTargetAdapter.sol";

contract ArcUsycTellerAdapter is VerifiedTargetAdapter {
    constructor(address router_, address admin)
        VerifiedTargetAdapter(router_, keccak256("ARC_USYC_TELLER_ADAPTER"), "Arc USYC Teller", admin)
    {}
}
