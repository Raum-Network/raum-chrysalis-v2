// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library Bytes32Address {
    function toBytes32(address account) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function toAddress(bytes32 value) internal pure returns (address) {
        return address(uint160(uint256(value)));
    }
}
