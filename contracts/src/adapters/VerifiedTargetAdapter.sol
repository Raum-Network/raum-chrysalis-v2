// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdapterBase} from "./AdapterBase.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";

contract VerifiedTargetAdapter is AdapterBase {
    struct TargetAction {
        address tokenIn;
        uint256 amount;
        address approvalTarget;
        address target;
        bytes callData;
        address refundToken;
    }

    mapping(bytes4 => bool) public allowedSelector;
    mapping(address => bool) public allowedTarget;

    event SelectorAllowed(bytes4 indexed selector, bool allowed);
    event TargetAllowed(address indexed target, bool allowed);
    event TargetCallExecuted(bytes32 indexed intentId, address indexed target, bytes4 selector, bytes returnData);

    constructor(address router_, bytes32 id_, string memory label_, address admin)
        AdapterBase(router_, id_, label_, admin)
    {}

    function setSelector(bytes4 selector, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedSelector[selector] = allowed;
        emit SelectorAllowed(selector, allowed);
    }

    function setTarget(address target, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function execute(AdapterCall calldata call_)
        external
        payable
        override
        onlyRouter
        nonReentrant
        returns (AdapterResult memory result)
    {
        TargetAction memory action = abi.decode(call_.actionData, (TargetAction));
        if (!allowedTarget[action.target]) revert ZeroAddress();
        bytes memory data = action.callData;
        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        if (!allowedSelector[selector]) revert SelectorNotAllowed(selector);

        uint256 amount = action.amount == 0 ? call_.amountIn : action.amount;
        if (action.tokenIn != address(0) && action.approvalTarget != address(0) && amount > 0) {
            _approveMax(action.tokenIn, action.approvalTarget, amount);
        }

        (bool ok, bytes memory returnData) = action.target.call(action.callData);
        if (!ok) revert CallFailed(returnData);

        emit TargetCallExecuted(call_.intentId, action.target, selector, returnData);
        return AdapterResult({tokenOut: action.refundToken, amountOut: 0, metadata: returnData});
    }
}
