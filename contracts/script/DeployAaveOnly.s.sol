// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcIntentRouterUpgradeable} from "../src/routers/ArcIntentRouterUpgradeable.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";

contract DeployAaveOnly is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(key);
        
        address routerAddress = vm.envAddress("ETHEREUM_ROUTER_ADDRESS");
        address aavePool = vm.envAddress("ETH_AAVE_POOL");

        vm.startBroadcast(key);
        ArcIntentRouterUpgradeable router = ArcIntentRouterUpgradeable(routerAddress);
        
        AaveV3Adapter aaveAdapter = new AaveV3Adapter(address(router), aavePool, admin);
        router.registerAdapter(bytes32("ETHEREUM_SEPOLIA"), bytes32("ETH_AAVE_V3"), address(aaveAdapter), true, "Aave V3 Ethereum Sepolia");
        
        vm.stopBroadcast();
        
        console2.log("Aave adapter deployed to:", address(aaveAdapter));
        console2.log("Registered to router:", routerAddress);
    }
}
