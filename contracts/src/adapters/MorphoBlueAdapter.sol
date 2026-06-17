// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdapterBase} from "./AdapterBase.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";
import {IMorphoBlue} from "../interfaces/IMorphoBlue.sol";

contract MorphoBlueAdapter is AdapterBase {
    enum Action {
        Supply,
        SupplyCollateral,
        Withdraw,
        WithdrawCollateral,
        Borrow,
        Repay
    }

    struct MorphoAction {
        Action action;
        IMorphoBlue.MarketParams market;
        uint256 assets;
        uint256 shares;
        address onBehalf;
        address receiver;
        bytes data;
    }

    IMorphoBlue public immutable morpho;

    event MorphoActionExecuted(bytes32 indexed intentId, Action indexed action, address loanToken, address collateralToken, uint256 amount, address account);

    constructor(address router_, address morpho_, address admin)
        AdapterBase(router_, keccak256("BASE_MORPHO_BLUE_ADAPTER"), "Morpho Blue Base Sepolia", admin)
    {
        if (morpho_ == address(0)) revert ZeroAddress();
        morpho = IMorphoBlue(morpho_);
    }

    function execute(AdapterCall calldata call_)
        external
        payable
        override
        onlyRouter
        nonReentrant
        returns (AdapterResult memory result)
    {
        MorphoAction memory action = abi.decode(call_.actionData, (MorphoAction));
        address account = action.onBehalf == address(0) ? call_.refundAddress : action.onBehalf;
        uint256 amount = action.assets == 0 ? call_.amountIn : action.assets;

        if (action.action == Action.Supply) {
            _approveMax(action.market.loanToken, address(morpho), amount);
            (uint256 assetsSupplied, uint256 sharesSupplied) = morpho.supply(action.market, amount, action.shares, account, action.data);
            emit MorphoActionExecuted(call_.intentId, action.action, action.market.loanToken, action.market.collateralToken, assetsSupplied, account);
            return AdapterResult({tokenOut: action.market.loanToken, amountOut: assetsSupplied, metadata: abi.encode(sharesSupplied, account)});
        }

        if (action.action == Action.SupplyCollateral) {
            _approveMax(action.market.collateralToken, address(morpho), amount);
            morpho.supplyCollateral(action.market, amount, account, action.data);
            emit MorphoActionExecuted(call_.intentId, action.action, action.market.loanToken, action.market.collateralToken, amount, account);
            return AdapterResult({tokenOut: action.market.collateralToken, amountOut: amount, metadata: abi.encode("COLLATERAL", account)});
        }

        address receiver = action.receiver == address(0) ? call_.refundAddress : action.receiver;

        if (action.action == Action.Withdraw) {
            (uint256 assetsWithdrawn, uint256 sharesWithdrawn) = morpho.withdraw(action.market, amount, action.shares, account, receiver);
            emit MorphoActionExecuted(call_.intentId, action.action, action.market.loanToken, action.market.collateralToken, assetsWithdrawn, receiver);
            return AdapterResult({tokenOut: action.market.loanToken, amountOut: assetsWithdrawn, metadata: abi.encode(sharesWithdrawn, receiver)});
        }

        if (action.action == Action.WithdrawCollateral) {
            morpho.withdrawCollateral(action.market, amount, account, receiver);
            emit MorphoActionExecuted(call_.intentId, action.action, action.market.loanToken, action.market.collateralToken, amount, receiver);
            return AdapterResult({tokenOut: action.market.collateralToken, amountOut: amount, metadata: abi.encode(receiver)});
        }

        if (action.action == Action.Borrow) {
            (uint256 assetsBorrowed, uint256 sharesBorrowed) = morpho.borrow(action.market, amount, action.shares, account, receiver);
            emit MorphoActionExecuted(call_.intentId, action.action, action.market.loanToken, action.market.collateralToken, assetsBorrowed, receiver);
            return AdapterResult({tokenOut: action.market.loanToken, amountOut: assetsBorrowed, metadata: abi.encode(sharesBorrowed, receiver)});
        }

        _approveMax(action.market.loanToken, address(morpho), amount);
        (uint256 assetsRepaid, uint256 sharesRepaid) = morpho.repay(action.market, amount, action.shares, account, action.data);
        emit MorphoActionExecuted(call_.intentId, action.action, action.market.loanToken, action.market.collateralToken, assetsRepaid, account);
        return AdapterResult({tokenOut: action.market.loanToken, amountOut: assetsRepaid, metadata: abi.encode(sharesRepaid, account)});
    }
}
