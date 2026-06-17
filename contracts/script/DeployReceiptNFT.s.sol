// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ArcReceiptNFT} from "../src/ArcReceiptNFT.sol";

/**
 * @notice Deploy ArcReceiptNFT to Arc Testnet.
 *
 * Usage:
 *   forge script script/DeployReceiptNFT.s.sol:DeployReceiptNFT \
 *     --rpc-url arc \
 *     --broadcast \
 *     --private-key $OPERATOR_PRIVATE_KEY
 *
 * After deployment set in .env:
 *   ARC_RECEIPT_NFT_ADDRESS=<deployed address>
 *
 * Then grant MINTER_ROLE to the operator wallet:
 *   cast send <NFT_ADDRESS> \
 *     "grantRole(bytes32,address)" \
 *     $(cast keccak "MINTER_ROLE") \
 *     $OPERATOR_ADDRESS \
 *     --rpc-url arc \
 *     --private-key $OPERATOR_PRIVATE_KEY
 */
contract DeployReceiptNFT is Script {
    function run() external {
        // Derive admin address from the private key used for broadcast
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerKey);

        // Grant MINTER_ROLE to operator wallet as well (separate from admin)
        address operator = vm.envOr("OPERATOR_ADDRESS", admin);

        vm.startBroadcast(deployerKey);
        ArcReceiptNFT nft = new ArcReceiptNFT(admin);

        // Grant MINTER_ROLE to the operator so it can mint without being admin
        if (operator != admin) {
            nft.grantRole(nft.MINTER_ROLE(), operator);
            console.log("MINTER_ROLE granted to operator:", operator);
        }
        vm.stopBroadcast();

        console.log("ArcReceiptNFT deployed at:", address(nft));
        console.log("Admin:", admin);
        console.log("Add to .env:");
        console.log("  ARC_RECEIPT_NFT_ADDRESS=", address(nft));
    }
}
