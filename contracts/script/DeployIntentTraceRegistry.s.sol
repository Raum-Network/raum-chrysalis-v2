// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IntentTraceRegistry} from "../src/IntentTraceRegistry.sol";

contract DeployIntentTraceRegistry is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envOr("INTENT_TRACE_ADMIN", vm.addr(key));
        address recorder = vm.envOr("INTENT_TRACE_RECORDER", admin);

        vm.startBroadcast(key);
        IntentTraceRegistry registry = new IntentTraceRegistry(admin);
        if (recorder != admin) {
            registry.setRecorder(recorder, true);
        }
        vm.stopBroadcast();

        console2.log("IntentTraceRegistry", address(registry));
        console2.log("Admin", admin);
        console2.log("Recorder", recorder);
    }
}
