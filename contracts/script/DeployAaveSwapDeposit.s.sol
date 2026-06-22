// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcIntentRouterUpgradeable} from "../src/routers/ArcIntentRouterUpgradeable.sol";
import {AaveV3SwapDepositAdapter} from "../src/adapters/AaveV3SwapDepositAdapter.sol";

contract DeployAaveSwapDeposit is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(key);
        
        address routerAddress = vm.envAddress("ETHEREUM_ROUTER_ADDRESS");
        address swapRouter = vm.envAddress("ETH_UNISWAP_SWAP_ROUTER_02");
        address aavePool = vm.envAddress("ETH_AAVE_POOL");

        vm.startBroadcast(key);
        ArcIntentRouterUpgradeable router = ArcIntentRouterUpgradeable(payable(routerAddress));
        
        AaveV3SwapDepositAdapter adapter = new AaveV3SwapDepositAdapter(
            address(router),
            swapRouter,
            aavePool,
            admin
        );
        
        router.registerAdapter(
            bytes32("ETHEREUM_SEPOLIA"),
            bytes32("ETH_AAVE_V3"),
            address(adapter),
            true,
            "Aave V3 Swap Deposit Ethereum Sepolia"
        );
        
        vm.stopBroadcast();
        
        console2.log("Aave Swap Deposit adapter deployed to:", address(adapter));
        console2.log("Registered to router:", routerAddress);
    }
}
