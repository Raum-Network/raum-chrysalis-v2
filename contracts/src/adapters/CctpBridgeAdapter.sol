// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdapterBase} from "./AdapterBase.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";
import {ITokenMessengerV2} from "../interfaces/ICctpV2.sol";

contract CctpBridgeAdapter is AdapterBase {
    struct BridgeAction {
        address burnToken;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
    }

    ITokenMessengerV2 public immutable tokenMessenger;

    event CctpBurnRequested(
        bytes32 indexed intentId,
        uint64 indexed nonce,
        address burnToken,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 destinationCaller
    );

    constructor(address router_, address tokenMessenger_, address admin)
        AdapterBase(router_, keccak256("CCTP_BRIDGE_ADAPTER"), "Circle CCTP V2 Bridge", admin)
    {
        if (tokenMessenger_ == address(0)) revert ZeroAddress();
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
    }

    function execute(AdapterCall calldata call_)
        external
        payable
        override
        onlyRouter
        nonReentrant
        returns (AdapterResult memory result)
    {
        BridgeAction memory action = abi.decode(call_.actionData, (BridgeAction));
        uint256 amount = action.amount == 0 ? call_.amountIn : action.amount;
        _approveMax(action.burnToken, address(tokenMessenger), amount);
        uint64 nonce = tokenMessenger.depositForBurn(
            amount,
            action.destinationDomain,
            action.mintRecipient,
            action.burnToken,
            action.destinationCaller,
            action.maxFee,
            action.minFinalityThreshold
        );
        emit CctpBurnRequested(call_.intentId, nonce, action.burnToken, amount, action.destinationDomain, action.mintRecipient, action.destinationCaller);
        return AdapterResult({tokenOut: address(0), amountOut: 0, metadata: abi.encode(nonce, action.destinationDomain, action.mintRecipient)});
    }
}
