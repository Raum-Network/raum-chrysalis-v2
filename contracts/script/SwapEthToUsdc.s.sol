// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address guy, uint wad) external returns (bool);
}

contract SwapEthToUsdc is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // Let's compute operator address from the key
        uint256 opKey = vm.envUint("OPERATOR_PRIVATE_KEY");
        address opAddr = vm.addr(opKey);
        
        address swapRouterAddress = vm.envAddress("ETH_UNISWAP_SWAP_ROUTER_02");
        address wethAddress = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
        address usdcAddress = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

        vm.startBroadcast(key);
        
        // 1. Wrap 0.02 ETH to WETH
        IWETH(wethAddress).deposit{value: 0.02 ether}();
        
        // 2. Approve SwapRouter
        IWETH(wethAddress).approve(swapRouterAddress, 0.02 ether);
        
        // 3. Swap WETH -> USDC
        ISwapRouter02 router = ISwapRouter02(swapRouterAddress);
        uint256 amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: wethAddress,
                tokenOut: usdcAddress,
                fee: 3000, // 0.3%
                recipient: opAddr, // Send USDC directly to the operator
                amountIn: 0.02 ether,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        
        vm.stopBroadcast();
        
        console2.log("Swapped 0.02 ETH for USDC:", amountOut);
        console2.log("Sent USDC to Operator:", opAddr);
    }
}
