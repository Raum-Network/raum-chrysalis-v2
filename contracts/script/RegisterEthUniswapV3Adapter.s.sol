// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcIntentRouterUpgradeable} from "../src/routers/ArcIntentRouterUpgradeable.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";

contract RegisterEthUniswapV3Adapter is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(key);
        address routerAddress = vm.envAddress("ETHEREUM_ROUTER_ADDRESS");
        address swapRouter02 = vm.envAddress("ETH_UNISWAP_SWAP_ROUTER_02");

        ArcIntentRouterUpgradeable router = ArcIntentRouterUpgradeable(payable(routerAddress));
        bytes32 chainKey = bytes32("ETHEREUM_SEPOLIA");
        bytes32 protocolKey = bytes32("ETH_UNISWAP_V3");
        bytes32 keyHash = router.adapterKey(chainKey, protocolKey);
        (address existing, bool enabled,,,) = router.adapters(keyHash);

        if (existing != address(0)) {
            console2.log("ETH_UNISWAP_V3 adapter already registered", existing);
            console2.log("enabled", enabled);
            return;
        }

        vm.startBroadcast(key);
        UniswapV3Adapter adapter = new UniswapV3Adapter(
            routerAddress,
            swapRouter02,
            keccak256("ETH_UNISWAP_V3_ADAPTER"),
            "Uniswap V3 Ethereum Sepolia",
            admin
        );
        router.registerAdapter(chainKey, protocolKey, address(adapter), true, "Uniswap V3 Ethereum Sepolia");
        vm.stopBroadcast();

        console2.log("Registered ETH_UNISWAP_V3 adapter", address(adapter));
        console2.log("Router", routerAddress);
    }
}
