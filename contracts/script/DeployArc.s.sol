// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ArcIntentRouterUpgradeable} from "../src/routers/ArcIntentRouterUpgradeable.sol";
import {CctpBridgeAdapter} from "../src/adapters/CctpBridgeAdapter.sol";
import {ArcUsycTellerAdapter} from "../src/adapters/ArcUsycTellerAdapter.sol";
import {GatewayWalletAdapter} from "../src/adapters/GatewayWalletAdapter.sol";
import {NoopReceiptAdapter} from "../src/adapters/NoopReceiptAdapter.sol";

contract DeployArc is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(key);
        address treasury = vm.envOr("TREASURY", admin);
        uint16 feeBps = uint16(vm.envOr("ROUTER_FEE_BPS", uint256(0)));

        vm.startBroadcast(key);
        ArcIntentRouterUpgradeable impl = new ArcIntentRouterUpgradeable();
        bytes memory init = abi.encodeCall(ArcIntentRouterUpgradeable.initialize, (admin, treasury, ARC_USDC, feeBps));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        ArcIntentRouterUpgradeable router = ArcIntentRouterUpgradeable(payable(address(proxy)));

        CctpBridgeAdapter cctp = new CctpBridgeAdapter(address(router), TOKEN_MESSENGER_V2, admin);
        ArcUsycTellerAdapter usyc = new ArcUsycTellerAdapter(address(router), admin);
        GatewayWalletAdapter gateway = new GatewayWalletAdapter(address(router), admin);
        NoopReceiptAdapter noop = new NoopReceiptAdapter(address(router), admin);

        // Allowlist the USYC Teller as a target on the adapter
        usyc.setTarget(0x9fdF14c5B14173D74C08Af27AebFf39240dC105A, true);
        usyc.setSelector(0x6e553f65, true); // deposit(uint256 assets, address receiver)
        usyc.setSelector(0x1e9a6950, true); // redeem(uint256 shares, address receiver, address account)

        router.registerAdapter(bytes32("ARC"), bytes32("CCTP_V2"), address(cctp), true, "Circle CCTP V2");
        router.registerAdapter(bytes32("ARC"), bytes32("ARC_USYC_TELLER"), address(usyc), true, "Arc USYC Teller");
        router.registerAdapter(bytes32("ARC"), bytes32("ARC_GATEWAY"), address(gateway), true, "Circle Gateway Wallet");
        router.registerAdapter(bytes32("ARC"), bytes32("OFFCHAIN_RECEIPT"), address(noop), true, "Offchain Receipt Adapter");
        vm.stopBroadcast();

        console2.log("Arc router proxy", address(router));
        console2.log("Arc router implementation", address(impl));
        console2.log("CCTP adapter", address(cctp));
        console2.log("USYC adapter", address(usyc));
        console2.log("Gateway adapter", address(gateway));
        console2.log("Noop receipt adapter", address(noop));
    }
}
