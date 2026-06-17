// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AdapterBase} from "./AdapterBase.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";

contract AaveV3Adapter is AdapterBase {
    enum Action {
        Supply,
        Withdraw
    }

    struct AaveAction {
        Action action;
        address asset;
        uint256 amount;
        address onBehalfOf;
        address receiver;
        uint16 referralCode;
    }

    IAavePool public immutable pool;

    event AaveActionExecuted(bytes32 indexed intentId, Action indexed action, address asset, uint256 amount, address account);

    constructor(address router_, address pool_, address admin)
        AdapterBase(router_, keccak256("ETH_AAVE_V3_ADAPTER"), "Aave V3 Ethereum Sepolia", admin)
    {
        if (pool_ == address(0)) revert ZeroAddress();
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
        AaveAction memory action = abi.decode(call_.actionData, (AaveAction));
        uint256 amount = action.amount == 0 ? call_.amountIn : action.amount;
        address account = action.onBehalfOf == address(0) ? call_.refundAddress : action.onBehalfOf;

        if (action.action == Action.Supply) {
            _approveMax(action.asset, address(pool), amount);
            pool.supply(action.asset, amount, account, action.referralCode);
            emit AaveActionExecuted(call_.intentId, action.action, action.asset, amount, account);
            return AdapterResult({tokenOut: action.asset, amountOut: amount, metadata: abi.encode("SUPPLY", account)});
        }

        address receiver = action.receiver == address(0) ? call_.refundAddress : action.receiver;
        uint256 withdrawn = pool.withdraw(action.asset, amount, receiver);
        emit AaveActionExecuted(call_.intentId, action.action, action.asset, withdrawn, receiver);
        return AdapterResult({tokenOut: action.asset, amountOut: withdrawn, metadata: abi.encode("WITHDRAW", receiver)});
    }
}
