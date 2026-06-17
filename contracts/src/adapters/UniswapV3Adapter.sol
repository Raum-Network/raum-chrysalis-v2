// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdapterBase} from "./AdapterBase.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract UniswapV3Adapter is AdapterBase {
    using SafeERC20 for IERC20;

    enum Action {
        ExactInputSingle,
        ExactInput,
        ExactOutputSingle,
        ExactOutput
    }

    struct SwapAction {
        Action action;
        address tokenIn;
        bytes params;
        address refundTo;
    }

    ISwapRouter02 public immutable swapRouter;

    event SwapExecuted(bytes32 indexed intentId, Action indexed action, address tokenIn, uint256 amountIn, uint256 amountOut);

    constructor(address router_, address swapRouter_, bytes32 id_, string memory label_, address admin)
        AdapterBase(router_, id_, label_, admin)
    {
        if (swapRouter_ == address(0)) revert ZeroAddress();
        swapRouter = ISwapRouter02(swapRouter_);
    }

    function execute(AdapterCall calldata call_)
        external
        payable
        override
        onlyRouter
        nonReentrant
        returns (AdapterResult memory result)
    {
        SwapAction memory action = abi.decode(call_.actionData, (SwapAction));
        address refundTo = action.refundTo == address(0) ? call_.refundAddress : action.refundTo;

        if (action.action == Action.ExactInputSingle) {
            ISwapRouter02.ExactInputSingleParams memory exactInputSingleParams = abi.decode(action.params, (ISwapRouter02.ExactInputSingleParams));
            uint256 exactInputSingleAmountIn = exactInputSingleParams.amountIn == 0 ? call_.amountIn : exactInputSingleParams.amountIn;
            address exactInputSingleRecipient = exactInputSingleParams.recipient == address(0) ? call_.refundAddress : exactInputSingleParams.recipient;

            _approveMax(exactInputSingleParams.tokenIn, address(swapRouter), exactInputSingleAmountIn);
            uint256 exactInputSingleAmountOut = swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: exactInputSingleParams.tokenIn,
                    tokenOut: exactInputSingleParams.tokenOut,
                    fee: exactInputSingleParams.fee,
                    recipient: exactInputSingleRecipient,
                    amountIn: exactInputSingleAmountIn,
                    amountOutMinimum: exactInputSingleParams.amountOutMinimum,
                    sqrtPriceLimitX96: exactInputSingleParams.sqrtPriceLimitX96
                })
            );

            emit SwapExecuted(call_.intentId, action.action, exactInputSingleParams.tokenIn, exactInputSingleAmountIn, exactInputSingleAmountOut);
            return AdapterResult({tokenOut: exactInputSingleParams.tokenOut, amountOut: exactInputSingleAmountOut, metadata: abi.encode(exactInputSingleRecipient)});
        }

        if (action.action == Action.ExactInput) {
            ISwapRouter02.ExactInputParams memory exactInputParams = abi.decode(action.params, (ISwapRouter02.ExactInputParams));
            uint256 exactInputAmountIn = exactInputParams.amountIn == 0 ? call_.amountIn : exactInputParams.amountIn;
            address exactInputRecipient = exactInputParams.recipient == address(0) ? call_.refundAddress : exactInputParams.recipient;

            _approveMax(action.tokenIn, address(swapRouter), exactInputAmountIn);
            uint256 exactInputAmountOut = swapRouter.exactInput(
                ISwapRouter02.ExactInputParams({
                    path: exactInputParams.path,
                    recipient: exactInputRecipient,
                    amountIn: exactInputAmountIn,
                    amountOutMinimum: exactInputParams.amountOutMinimum
                })
            );

            emit SwapExecuted(call_.intentId, action.action, action.tokenIn, exactInputAmountIn, exactInputAmountOut);
            return AdapterResult({tokenOut: address(0), amountOut: exactInputAmountOut, metadata: abi.encode(exactInputRecipient, exactInputParams.path)});
        }

        if (action.action == Action.ExactOutputSingle) {
            ISwapRouter02.ExactOutputSingleParams memory exactOutputSingleParams = abi.decode(action.params, (ISwapRouter02.ExactOutputSingleParams));
            uint256 exactOutputSingleAmountInMaximum = exactOutputSingleParams.amountInMaximum == 0 ? call_.amountIn : exactOutputSingleParams.amountInMaximum;
            address exactOutputSingleRecipient = exactOutputSingleParams.recipient == address(0) ? call_.refundAddress : exactOutputSingleParams.recipient;

            _approveMax(exactOutputSingleParams.tokenIn, address(swapRouter), exactOutputSingleAmountInMaximum);
            uint256 exactOutputSingleAmountIn = swapRouter.exactOutputSingle(
                ISwapRouter02.ExactOutputSingleParams({
                    tokenIn: exactOutputSingleParams.tokenIn,
                    tokenOut: exactOutputSingleParams.tokenOut,
                    fee: exactOutputSingleParams.fee,
                    recipient: exactOutputSingleRecipient,
                    amountOut: exactOutputSingleParams.amountOut,
                    amountInMaximum: exactOutputSingleAmountInMaximum,
                    sqrtPriceLimitX96: exactOutputSingleParams.sqrtPriceLimitX96
                })
            );
            _refundRemaining(exactOutputSingleParams.tokenIn, refundTo);

            emit SwapExecuted(call_.intentId, action.action, exactOutputSingleParams.tokenIn, exactOutputSingleAmountIn, exactOutputSingleParams.amountOut);
            return AdapterResult({tokenOut: exactOutputSingleParams.tokenOut, amountOut: exactOutputSingleParams.amountOut, metadata: abi.encode(exactOutputSingleRecipient, exactOutputSingleAmountIn)});
        }

        ISwapRouter02.ExactOutputParams memory exactOutputParams = abi.decode(action.params, (ISwapRouter02.ExactOutputParams));
        uint256 exactOutputAmountInMaximum = exactOutputParams.amountInMaximum == 0 ? call_.amountIn : exactOutputParams.amountInMaximum;
        address exactOutputRecipient = exactOutputParams.recipient == address(0) ? call_.refundAddress : exactOutputParams.recipient;

        _approveMax(action.tokenIn, address(swapRouter), exactOutputAmountInMaximum);
        uint256 exactOutputAmountIn = swapRouter.exactOutput(
            ISwapRouter02.ExactOutputParams({
                path: exactOutputParams.path,
                recipient: exactOutputRecipient,
                amountOut: exactOutputParams.amountOut,
                amountInMaximum: exactOutputAmountInMaximum
            })
        );
        _refundRemaining(action.tokenIn, refundTo);

        emit SwapExecuted(call_.intentId, action.action, action.tokenIn, exactOutputAmountIn, exactOutputParams.amountOut);
        return AdapterResult({tokenOut: address(0), amountOut: exactOutputParams.amountOut, metadata: abi.encode(exactOutputRecipient, exactOutputAmountIn, exactOutputParams.path)});
    }

    function _refundRemaining(address token, address to) private {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) IERC20(token).safeTransfer(to, balance);
    }
}
