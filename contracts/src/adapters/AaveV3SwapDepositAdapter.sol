// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdapterBase} from "./AdapterBase.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract AaveV3SwapDepositAdapter is AdapterBase {
    using SafeERC20 for IERC20;

    struct SwapDepositAction {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
        uint256 amountOutMin;
        address onBehalfOf;
        uint16 referralCode;
    }

    ISwapRouter02 public immutable swapRouter;
    IAavePool public immutable pool;

    event SwapDepositExecuted(
        bytes32 indexed intentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountSwapped,
        address onBehalfOf
    );

    constructor(
        address router_,
        address swapRouter_,
        address pool_,
        address admin
    )
        AdapterBase(
            router_,
            keccak256("ETH_AAVE_V3_SWAP_DEPOSIT_ADAPTER"),
            "Aave V3 Swap Deposit Ethereum Sepolia",
            admin
        )
    {
        if (swapRouter_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        swapRouter = ISwapRouter02(swapRouter_);
        pool = IAavePool(pool_);
    }

    function execute(AdapterCall calldata call_)
        external
        payable
        override
        onlyRouter
        nonReentrant
        returns (AdapterResult memory result)
    {
        SwapDepositAction memory action = abi.decode(call_.actionData, (SwapDepositAction));
        uint256 amountIn = action.amountIn == 0 ? call_.amountIn : action.amountIn;
        address account = action.onBehalfOf == address(0) ? call_.refundAddress : action.onBehalfOf;

        // 1. Swap tokenIn (Circle USDC) to tokenOut (Aave USDC) on Uniswap V3
        _approveMax(action.tokenIn, address(swapRouter), amountIn);
        
        uint256 amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: action.tokenIn,
                tokenOut: action.tokenOut,
                fee: action.fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: action.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        // 2. Supply tokenOut (Aave USDC) to Aave V3 Pool
        _approveMax(action.tokenOut, address(pool), amountOut);
        pool.supply(action.tokenOut, amountOut, account, action.referralCode);

        emit SwapDepositExecuted(
            call_.intentId,
            action.tokenIn,
            action.tokenOut,
            amountIn,
            amountOut,
            account
        );

        return AdapterResult({
            tokenOut: action.tokenOut,
            amountOut: amountOut,
            metadata: abi.encode("SWAP_SUPPLY", account)
        });
    }
}
