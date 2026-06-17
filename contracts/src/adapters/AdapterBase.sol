// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";

abstract contract AdapterBase is IProtocolAdapter, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SWEEPER_ROLE = keccak256("SWEEPER_ROLE");
    address public immutable router;
    bytes32 private immutable id;
    string private name;

    error OnlyRouter();
    error ZeroAddress();
    error CallFailed(bytes returndata);
    error SelectorNotAllowed(bytes4 selector);

    modifier onlyRouter() {
        if (msg.sender != router) revert OnlyRouter();
        _;
    }

    constructor(address router_, bytes32 id_, string memory name_, address admin) {
        if (router_ == address(0) || admin == address(0)) revert ZeroAddress();
        router = router_;
        id = id_;
        name = name_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SWEEPER_ROLE, admin);
    }

    function adapterId() external view override returns (bytes32) {
        return id;
    }

    function protocolName() external view override returns (string memory) {
        return name;
    }

    function sweep(address token, address to, uint256 amount) external onlyRole(SWEEPER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    function _approveMax(address token, address spender, uint256 amount) internal {
        IERC20(token).forceApprove(spender, 0);
        IERC20(token).forceApprove(spender, amount);
    }
}
