// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";

contract MockAdapter is IProtocolAdapter {
    using SafeERC20 for IERC20;

    bytes32 public immutable id;
    bool public shouldRevert;

    constructor(bytes32 id_) {
        id = id_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function adapterId() external view returns (bytes32) {
        return id;
    }

    function protocolName() external pure returns (string memory) {
        return "Mock";
    }

    function execute(AdapterCall calldata call_) external payable returns (AdapterResult memory result) {
        require(!shouldRevert, "MOCK_REVERT");
        IERC20(call_.tokenIn).safeTransfer(call_.refundAddress, call_.amountIn);
        return AdapterResult({tokenOut: call_.tokenIn, amountOut: call_.amountIn, metadata: call_.actionData});
    }
}
