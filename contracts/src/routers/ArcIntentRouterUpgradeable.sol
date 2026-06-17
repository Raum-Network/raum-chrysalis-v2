// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProtocolAdapter} from "../interfaces/IProtocolAdapter.sol";

contract ArcIntentRouterUpgradeable is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant ADAPTER_ADMIN_ROLE = keccak256("ADAPTER_ADMIN_ROLE");

    uint16 public constant MAX_FEE_BPS = 100;

    enum IntentStatus {
        None,
        Created,
        Executed,
        Failed,
        RemoteRecorded
    }

    struct AdapterRecord {
        address adapter;
        bool enabled;
        bytes32 chainKey;
        bytes32 protocolKey;
        string label;
    }

    struct IntentRecord {
        address initiator;
        bytes32 sourceChainKey;
        bytes32 destinationChainKey;
        bytes32 protocolKey;
        address tokenIn;
        uint256 amountIn;
        uint256 feeAmount;
        IntentStatus status;
        bytes result;
    }

    address public treasury;
    address public canonicalUsdc;
    uint16 public feeBps;

    mapping(bytes32 => AdapterRecord) public adapters;
    mapping(bytes32 => IntentRecord) public intents;

    event AdapterRegistered(
        bytes32 indexed adapterKey,
        bytes32 indexed chainKey,
        bytes32 indexed protocolKey,
        address adapter,
        bool enabled,
        string label
    );
    event AdapterStatusChanged(bytes32 indexed adapterKey, bool enabled);
    event IntentCreated(
        bytes32 indexed intentId,
        address indexed initiator,
        bytes32 indexed destinationChainKey,
        bytes32 protocolKey,
        address tokenIn,
        uint256 amountIn
    );
    event IntentExecuted(bytes32 indexed intentId, bytes32 indexed adapterKey, address tokenOut, uint256 amountOut, bytes metadata);
    event IntentFailed(bytes32 indexed intentId, bytes32 indexed adapterKey, bytes reason);
    event RemoteIntentRecorded(bytes32 indexed intentId, bytes32 indexed sourceChainKey, bytes32 indexed protocolKey, address beneficiary, uint256 amount, bytes receipt);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);

    error AdapterNotFound(bytes32 adapterKey);
    error AdapterDisabled(bytes32 adapterKey);
    error BadTreasury();
    error FeeTooHigh();
    error ZeroAmount();
    error InvalidAddress();
    error IntentAlreadyExists(bytes32 intentId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address treasury_, address canonicalUsdc_, uint16 feeBps_) external initializer {
        if (admin == address(0) || treasury_ == address(0) || canonicalUsdc_ == address(0)) revert InvalidAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        _grantRole(ADAPTER_ADMIN_ROLE, admin);

        treasury = treasury_;
        canonicalUsdc = canonicalUsdc_;
        feeBps = feeBps_;
    }

    function adapterKey(bytes32 chainKey, bytes32 protocolKey) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(chainKey, protocolKey));
    }

    function registerAdapter(
        bytes32 chainKey,
        bytes32 protocolKey,
        address adapter,
        bool enabled,
        string calldata label
    ) external onlyRole(ADAPTER_ADMIN_ROLE) {
        if (adapter == address(0)) revert InvalidAddress();
        bytes32 key = adapterKey(chainKey, protocolKey);
        adapters[key] = AdapterRecord({adapter: adapter, enabled: enabled, chainKey: chainKey, protocolKey: protocolKey, label: label});
        emit AdapterRegistered(key, chainKey, protocolKey, adapter, enabled, label);
    }

    function setAdapterStatus(bytes32 chainKey, bytes32 protocolKey, bool enabled) external onlyRole(ADAPTER_ADMIN_ROLE) {
        bytes32 key = adapterKey(chainKey, protocolKey);
        if (adapters[key].adapter == address(0)) revert AdapterNotFound(key);
        adapters[key].enabled = enabled;
        emit AdapterStatusChanged(key, enabled);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert BadTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setFeeBps(uint16 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function routeLocal(
        bytes32 destinationChainKey,
        bytes32 protocolKey,
        address tokenIn,
        uint256 amountIn,
        address refundAddress,
        bytes calldata actionData
    ) external payable nonReentrant whenNotPaused returns (bytes32 intentId) {
        if (amountIn == 0) revert ZeroAmount();
        if (refundAddress == address(0)) refundAddress = msg.sender;

        bytes32 key = adapterKey(destinationChainKey, protocolKey);
        AdapterRecord memory record = adapters[key];
        if (record.adapter == address(0)) revert AdapterNotFound(key);
        if (!record.enabled) revert AdapterDisabled(key);

        intentId = keccak256(
            abi.encodePacked(block.chainid, address(this), msg.sender, destinationChainKey, protocolKey, tokenIn, amountIn, block.number, actionData)
        );
        if (intents[intentId].status != IntentStatus.None) revert IntentAlreadyExists(intentId);

        uint256 feeAmount = (amountIn * feeBps) / 10_000;
        uint256 adapterAmount = amountIn - feeAmount;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (feeAmount > 0) IERC20(tokenIn).safeTransfer(treasury, feeAmount);
        IERC20(tokenIn).safeTransfer(record.adapter, adapterAmount);

        intents[intentId] = IntentRecord({
            initiator: msg.sender,
            sourceChainKey: bytes32(uint256(block.chainid)),
            destinationChainKey: destinationChainKey,
            protocolKey: protocolKey,
            tokenIn: tokenIn,
            amountIn: adapterAmount,
            feeAmount: feeAmount,
            status: IntentStatus.Created,
            result: ""
        });

        emit IntentCreated(intentId, msg.sender, destinationChainKey, protocolKey, tokenIn, adapterAmount);

        IProtocolAdapter.AdapterResult memory result = IProtocolAdapter(record.adapter).execute{value: msg.value}(
            IProtocolAdapter.AdapterCall({
                intentId: intentId,
                initiator: msg.sender,
                tokenIn: tokenIn,
                amountIn: adapterAmount,
                refundAddress: refundAddress,
                actionData: actionData
            })
        );

        intents[intentId].status = IntentStatus.Executed;
        intents[intentId].result = abi.encode(result);
        emit IntentExecuted(intentId, key, result.tokenOut, result.amountOut, result.metadata);
    }

    /// @notice Execute a protocol adapter using tokens already held by this router, e.g. after CCTP mint or Gateway mint.
    function executeWithRouterBalance(
        bytes32 destinationChainKey,
        bytes32 protocolKey,
        address beneficiary,
        address tokenIn,
        uint256 amountIn,
        bytes calldata actionData
    ) external payable nonReentrant whenNotPaused onlyRole(OPERATOR_ROLE) returns (bytes32 intentId) {
        if (amountIn == 0) revert ZeroAmount();
        if (beneficiary == address(0)) revert InvalidAddress();

        bytes32 key = adapterKey(destinationChainKey, protocolKey);
        AdapterRecord memory record = adapters[key];
        if (record.adapter == address(0)) revert AdapterNotFound(key);
        if (!record.enabled) revert AdapterDisabled(key);

        intentId = keccak256(abi.encodePacked(block.chainid, address(this), beneficiary, destinationChainKey, protocolKey, tokenIn, amountIn, block.timestamp, actionData));
        if (intents[intentId].status != IntentStatus.None) revert IntentAlreadyExists(intentId);

        uint256 feeAmount = (amountIn * feeBps) / 10_000;
        uint256 adapterAmount = amountIn - feeAmount;
        if (feeAmount > 0) IERC20(tokenIn).safeTransfer(treasury, feeAmount);
        IERC20(tokenIn).safeTransfer(record.adapter, adapterAmount);

        intents[intentId] = IntentRecord({
            initiator: beneficiary,
            sourceChainKey: bytes32(uint256(block.chainid)),
            destinationChainKey: destinationChainKey,
            protocolKey: protocolKey,
            tokenIn: tokenIn,
            amountIn: adapterAmount,
            feeAmount: feeAmount,
            status: IntentStatus.Created,
            result: ""
        });

        emit IntentCreated(intentId, beneficiary, destinationChainKey, protocolKey, tokenIn, adapterAmount);

        IProtocolAdapter.AdapterResult memory result = IProtocolAdapter(record.adapter).execute{value: msg.value}(
            IProtocolAdapter.AdapterCall({
                intentId: intentId,
                initiator: beneficiary,
                tokenIn: tokenIn,
                amountIn: adapterAmount,
                refundAddress: beneficiary,
                actionData: actionData
            })
        );

        intents[intentId].status = IntentStatus.Executed;
        intents[intentId].result = abi.encode(result);
        emit IntentExecuted(intentId, key, result.tokenOut, result.amountOut, result.metadata);
    }

    function recordRemoteIntent(
        bytes32 intentId,
        bytes32 sourceChainKey,
        bytes32 protocolKey,
        address beneficiary,
        uint256 amount,
        bytes calldata receipt
    ) external onlyRole(OPERATOR_ROLE) {
        if (intents[intentId].status != IntentStatus.None) revert IntentAlreadyExists(intentId);
        intents[intentId] = IntentRecord({
            initiator: beneficiary,
            sourceChainKey: sourceChainKey,
            destinationChainKey: bytes32(uint256(block.chainid)),
            protocolKey: protocolKey,
            tokenIn: canonicalUsdc,
            amountIn: amount,
            feeAmount: 0,
            status: IntentStatus.RemoteRecorded,
            result: receipt
        });
        emit RemoteIntentRecorded(intentId, sourceChainKey, protocolKey, beneficiary, amount, receipt);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    receive() external payable {}

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
