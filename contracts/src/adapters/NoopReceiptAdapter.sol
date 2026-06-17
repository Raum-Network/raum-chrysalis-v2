// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdapterBase} from "./AdapterBase.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";

contract NoopReceiptAdapter is AdapterBase {
    event OffchainReceipt(bytes32 indexed intentId, address indexed initiator, bytes metadata);

    constructor(address router_, address admin)
        AdapterBase(router_, keccak256("NOOP_RECEIPT_ADAPTER"), "Offchain Receipt Adapter", admin)
    {}

    function execute(AdapterCall calldata call_)
        external
        payable
        override
        onlyRouter
        nonReentrant
        returns (AdapterResult memory result)
    {
        emit OffchainReceipt(call_.intentId, call_.initiator, call_.actionData);
        return AdapterResult({tokenOut: call_.tokenIn, amountOut: call_.amountIn, metadata: call_.actionData});
    }
}
