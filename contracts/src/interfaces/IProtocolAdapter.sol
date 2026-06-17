// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProtocolAdapter {
    struct AdapterCall {
        bytes32 intentId;
        address initiator;
        address tokenIn;
        uint256 amountIn;
        address refundAddress;
        bytes actionData;
    }

    struct AdapterResult {
        address tokenOut;
        uint256 amountOut;
        bytes metadata;
    }

    function adapterId() external view returns (bytes32);
    function protocolName() external view returns (string memory);
    function execute(AdapterCall calldata call_) external payable returns (AdapterResult memory result);
}
