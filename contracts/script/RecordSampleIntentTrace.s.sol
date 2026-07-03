// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IntentTraceRegistry} from "../src/IntentTraceRegistry.sol";

contract RecordSampleIntentTrace is Script {
    function run() external {
        uint256 key = vm.envOr("INTENT_TRACE_RECORDER_PRIVATE_KEY", vm.envUint("DEPLOYER_PRIVATE_KEY"));
        IntentTraceRegistry registry = IntentTraceRegistry(vm.envAddress("INTENT_TRACE_REGISTRY"));

        bytes32 intentId = vm.envOr("SAMPLE_INTENT_ID", keccak256("chrysalis-v2-demo-intent-trace"));
        address userAddress = vm.envOr("SAMPLE_USER_ADDRESS", vm.addr(key));
        uint256 amount = vm.envOr("SAMPLE_AMOUNT", uint256(1_000_000));

        vm.startBroadcast(key);
        registry.registerIntent(
            intentId,
            userAddress,
            keccak256(abi.encodePacked("demo-user:", userAddress)),
            bytes32("ETHEREUM_SEPOLIA"),
            bytes32("SOLANA_DEVNET"),
            bytes32("SOL_MARINADE"),
            bytes32("STAKE"),
            bytes32("USDC"),
            amount
        );
        registry.recordStep(
            intentId,
            bytes32("SOURCE_DEPOSIT"),
            bytes32("ETHEREUM_SEPOLIA"),
            keccak256("sample-source-deposit-tx"),
            vm.envOr("ETHEREUM_ROUTER_ADDRESS", address(0)),
            bytes4(keccak256("routeLocal(bytes32,bytes32,address,uint256,address,bytes)")),
            bytes32("ETH_USDC_TRANSFER"),
            amount
        );
        registry.recordStep(
            intentId,
            bytes32("BRIDGE_BURN"),
            bytes32("ETHEREUM_SEPOLIA"),
            keccak256("sample-cctp-burn-tx"),
            address(0),
            bytes4(0),
            bytes32("CCTP_V2"),
            amount
        );
        registry.recordExternalStep(
            intentId,
            bytes32("BRIDGE_MINT"),
            bytes32("SOLANA_DEVNET"),
            "demo-solana-cctp-mint-signature",
            address(0),
            bytes4(0),
            bytes32("CCTP_V2"),
            amount
        );
        registry.recordExternalStep(
            intentId,
            bytes32("PROTOCOL_CALL"),
            bytes32("SOLANA_DEVNET"),
            "demo-solana-marinade-stake-signature",
            address(0),
            bytes4(0),
            bytes32("SOL_MARINADE"),
            amount
        );
        registry.recordStep(
            intentId,
            bytes32("RECEIPT_MINT"),
            bytes32("ARC"),
            keccak256("sample-arc-receipt-mint-tx"),
            vm.envOr("ARC_RECEIPT_NFT_ADDRESS", address(0)),
            bytes4(keccak256("mintIntentReceipt(address,string,string,string,string,string,string,string)")),
            bytes32("ARC_RECEIPT"),
            amount
        );
        registry.updateIntentStatus(intentId, registry.STATUS_COMPLETED());
        vm.stopBroadcast();

        console2.logBytes32(intentId);
    }
}
