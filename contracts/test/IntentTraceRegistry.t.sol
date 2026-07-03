// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IntentTraceRegistry} from "../src/IntentTraceRegistry.sol";

contract IntentTraceRegistryTest is Test {
    IntentTraceRegistry private registry;
    address private admin = address(0xA11CE);
    address private recorder = address(0xB0B);
    address private user = address(0xCAFE);

    bytes32 private constant INTENT_ID = keccak256("intent-1");

    function setUp() public {
        registry = new IntentTraceRegistry(admin);
        vm.prank(admin);
        registry.setRecorder(recorder, true);
    }

    function testRecordUniversalTrace() public {
        vm.startPrank(recorder);
        registry.registerIntent(
            INTENT_ID,
            user,
            keccak256("solana-user"),
            bytes32("SOLANA_DEVNET"),
            bytes32("ETHEREUM_SEPOLIA"),
            bytes32("ETH_AAVE_V3"),
            bytes32("DEPOSIT"),
            bytes32("USDC"),
            1_000_000
        );

        uint16 firstStep = registry.recordExternalStep(
            INTENT_ID,
            bytes32("SOURCE_DEPOSIT"),
            bytes32("SOLANA_DEVNET"),
            "5tNonEvmSourceSignature",
            address(0),
            bytes4(0),
            bytes32("SOL_USDC_TRANSFER"),
            1_000_000
        );
        uint16 secondStep = registry.recordStep(
            INTENT_ID,
            bytes32("PROTOCOL_CALL"),
            bytes32("ETHEREUM_SEPOLIA"),
            keccak256("0xevm-protocol-tx"),
            address(0x1234),
            bytes4(keccak256("execute(bytes)")),
            bytes32("ETH_AAVE_V3"),
            1_000_000
        );
        registry.updateIntentStatus(INTENT_ID, registry.STATUS_COMPLETED());
        vm.stopPrank();

        assertEq(firstStep, 0);
        assertEq(secondStep, 1);

        (
            address userAddress,
            bytes32 userRef,
            bytes32 sourceChainKey,
            bytes32 destinationChainKey,
            bytes32 protocolKey,
            bytes32 actionKey,
            bytes32 assetKey,
            uint256 amount,,,
            uint16 stepCount,
            uint8 status
        ) = registry.intents(INTENT_ID);

        assertEq(userAddress, user);
        assertEq(userRef, keccak256("solana-user"));
        assertEq(sourceChainKey, bytes32("SOLANA_DEVNET"));
        assertEq(destinationChainKey, bytes32("ETHEREUM_SEPOLIA"));
        assertEq(protocolKey, bytes32("ETH_AAVE_V3"));
        assertEq(actionKey, bytes32("DEPOSIT"));
        assertEq(assetKey, bytes32("USDC"));
        assertEq(amount, 1_000_000);
        assertEq(stepCount, 2);
        assertEq(status, registry.STATUS_COMPLETED());
    }

    function testOnlyRecorderCanWrite() public {
        vm.expectRevert();
        registry.registerIntent(
            INTENT_ID,
            user,
            bytes32(0),
            bytes32("ETHEREUM_SEPOLIA"),
            bytes32("BASE_SEPOLIA"),
            bytes32("BASE_UNISWAP_V3"),
            bytes32("SWAP"),
            bytes32("USDC"),
            1
        );
    }
}
