// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ArcIntentRouterUpgradeable} from "../src/routers/ArcIntentRouterUpgradeable.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {AaveV3SwapDepositAdapter} from "../src/adapters/AaveV3SwapDepositAdapter.sol";
import {MorphoBlueAdapter} from "../src/adapters/MorphoBlueAdapter.sol";
import {NoopReceiptAdapter} from "../src/adapters/NoopReceiptAdapter.sol";

contract DeployDestination is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(key);
        address treasury = vm.envOr("TREASURY", admin);
        uint16 feeBps = uint16(vm.envOr("ROUTER_FEE_BPS", uint256(0)));
        address usdc = vm.envAddress("DESTINATION_USDC");

        vm.startBroadcast(key);
        ArcIntentRouterUpgradeable impl = new ArcIntentRouterUpgradeable();
        bytes memory init = abi.encodeCall(ArcIntentRouterUpgradeable.initialize, (admin, treasury, usdc, feeBps));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        ArcIntentRouterUpgradeable router = ArcIntentRouterUpgradeable(payable(address(proxy)));

        NoopReceiptAdapter noop = new NoopReceiptAdapter(address(router), admin);
        router.registerAdapter(bytes32("DEST"), bytes32("OFFCHAIN_RECEIPT"), address(noop), true, "Offchain Receipt Adapter");

        if (block.chainid == 84532) {
            address uni = vm.envAddress("BASE_UNISWAP_SWAP_ROUTER_02");
            address morpho = vm.envAddress("BASE_MORPHO_BLUE");
            UniswapV3Adapter uniAdapter = new UniswapV3Adapter(address(router), uni, keccak256("BASE_UNISWAP_V3_ADAPTER"), "Uniswap V3 Base Sepolia", admin);
            MorphoBlueAdapter morphoAdapter = new MorphoBlueAdapter(address(router), morpho, admin);
            router.registerAdapter(bytes32("BASE_SEPOLIA"), bytes32("BASE_UNISWAP_V3"), address(uniAdapter), true, "Uniswap V3 Base Sepolia");
            router.registerAdapter(bytes32("BASE_SEPOLIA"), bytes32("BASE_MORPHO_BLUE"), address(morphoAdapter), true, "Morpho Blue Base Sepolia");
            console2.log("Uniswap adapter", address(uniAdapter));
            console2.log("Morpho adapter", address(morphoAdapter));
        }

        if (block.chainid == 11155111) {
            address uni = vm.envAddress("ETH_UNISWAP_SWAP_ROUTER_02");
            address aavePool = vm.envAddress("ETH_AAVE_POOL");
            UniswapV3Adapter uniAdapter = new UniswapV3Adapter(address(router), uni, keccak256("ETH_UNISWAP_V3_ADAPTER"), "Uniswap V3 Ethereum Sepolia", admin);
            AaveV3SwapDepositAdapter aaveAdapter = new AaveV3SwapDepositAdapter(address(router), uni, aavePool, admin);
            router.registerAdapter(bytes32("ETHEREUM_SEPOLIA"), bytes32("ETH_UNISWAP_V3"), address(uniAdapter), true, "Uniswap V3 Ethereum Sepolia");
            router.registerAdapter(bytes32("ETHEREUM_SEPOLIA"), bytes32("ETH_AAVE_V3"), address(aaveAdapter), true, "Aave V3 Swap Deposit Ethereum Sepolia");
            console2.log("Uniswap adapter", address(uniAdapter));
            console2.log("Aave adapter", address(aaveAdapter));
        }

        vm.stopBroadcast();
        console2.log("Destination router proxy", address(router));
        console2.log("Destination implementation", address(impl));
        console2.log("Noop receipt adapter", address(noop));
    }
}
