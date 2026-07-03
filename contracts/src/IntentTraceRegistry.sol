// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lightweight event registry for cross-chain intent lifecycle analytics.
/// @dev It does not custody funds or validate bridges. Operators record verified lifecycle steps so Dune can join
/// EVM and non-EVM legs by one intent id.
contract IntentTraceRegistry {
    uint8 public constant STATUS_REGISTERED = 1;
    uint8 public constant STATUS_COMPLETED = 2;
    uint8 public constant STATUS_FAILED = 3;

    address public admin;
    bool public paused;
    mapping(address => bool) public recorders;

    struct Intent {
        address userAddress;
        bytes32 userRef;
        bytes32 sourceChainKey;
        bytes32 destinationChainKey;
        bytes32 protocolKey;
        bytes32 actionKey;
        bytes32 assetKey;
        uint256 amount;
        uint64 createdAt;
        uint64 updatedAt;
        uint16 stepCount;
        uint8 status;
    }

    struct TraceStep {
        bytes32 stageKey;
        bytes32 chainKey;
        bytes32 txHashRef;
        address targetContract;
        bytes4 functionSelector;
        bytes32 protocolKey;
        uint256 amount;
        uint64 recordedAt;
    }

    mapping(bytes32 => Intent) public intents;
    mapping(bytes32 => mapping(uint16 => TraceStep)) public traceSteps;

    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event RecorderUpdated(address indexed recorder, bool enabled);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    event IntentRegistered(
        bytes32 indexed intentId,
        address indexed userAddress,
        bytes32 indexed sourceChainKey,
        bytes32 userRef,
        bytes32 destinationChainKey,
        bytes32 protocolKey,
        bytes32 actionKey,
        bytes32 assetKey,
        uint256 amount,
        uint64 createdAt
    );

    event TraceStepRecorded(
        bytes32 indexed intentId,
        bytes32 indexed stageKey,
        bytes32 indexed chainKey,
        uint16 stepIndex,
        bytes32 txHashRef,
        address targetContract,
        bytes4 functionSelector,
        bytes32 protocolKey,
        uint256 amount,
        uint64 recordedAt
    );

    event ExternalTransactionRecorded(
        bytes32 indexed intentId,
        uint16 indexed stepIndex,
        bytes32 indexed chainKey,
        bytes32 txHashRef,
        string externalTxHash
    );

    event IntentStatusUpdated(bytes32 indexed intentId, uint8 indexed status, uint64 updatedAt);

    error ZeroAdmin();
    error NotAdmin();
    error NotRecorder();
    error PausedRegistry();
    error IntentAlreadyRegistered(bytes32 intentId);
    error IntentNotRegistered(bytes32 intentId);
    error BadStatus(uint8 status);
    error EmptyExternalTxHash();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyRecorder() {
        if (!recorders[msg.sender]) revert NotRecorder();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedRegistry();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAdmin();
        admin = admin_;
        recorders[admin_] = true;
        emit AdminTransferred(address(0), admin_);
        emit RecorderUpdated(admin_, true);
    }

    function setRecorder(address recorder, bool enabled) external onlyAdmin {
        recorders[recorder] = enabled;
        emit RecorderUpdated(recorder, enabled);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAdmin();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function registerIntent(
        bytes32 intentId,
        address userAddress,
        bytes32 userRef,
        bytes32 sourceChainKey,
        bytes32 destinationChainKey,
        bytes32 protocolKey,
        bytes32 actionKey,
        bytes32 assetKey,
        uint256 amount
    ) external onlyRecorder whenNotPaused {
        if (intents[intentId].status != 0) revert IntentAlreadyRegistered(intentId);

        uint64 nowTs = uint64(block.timestamp);
        intents[intentId] = Intent({
            userAddress: userAddress,
            userRef: userRef,
            sourceChainKey: sourceChainKey,
            destinationChainKey: destinationChainKey,
            protocolKey: protocolKey,
            actionKey: actionKey,
            assetKey: assetKey,
            amount: amount,
            createdAt: nowTs,
            updatedAt: nowTs,
            stepCount: 0,
            status: STATUS_REGISTERED
        });

        emit IntentRegistered(
            intentId,
            userAddress,
            sourceChainKey,
            userRef,
            destinationChainKey,
            protocolKey,
            actionKey,
            assetKey,
            amount,
            nowTs
        );
    }

    function recordStep(
        bytes32 intentId,
        bytes32 stageKey,
        bytes32 chainKey,
        bytes32 txHashRef,
        address targetContract,
        bytes4 functionSelector,
        bytes32 protocolKey,
        uint256 amount
    ) public onlyRecorder whenNotPaused returns (uint16 stepIndex) {
        Intent storage intent = intents[intentId];
        if (intent.status == 0) revert IntentNotRegistered(intentId);

        stepIndex = intent.stepCount;
        uint64 nowTs = uint64(block.timestamp);
        traceSteps[intentId][stepIndex] = TraceStep({
            stageKey: stageKey,
            chainKey: chainKey,
            txHashRef: txHashRef,
            targetContract: targetContract,
            functionSelector: functionSelector,
            protocolKey: protocolKey,
            amount: amount,
            recordedAt: nowTs
        });
        intent.stepCount = stepIndex + 1;
        intent.updatedAt = nowTs;

        emit TraceStepRecorded(
            intentId,
            stageKey,
            chainKey,
            stepIndex,
            txHashRef,
            targetContract,
            functionSelector,
            protocolKey,
            amount,
            nowTs
        );
    }

    function recordExternalStep(
        bytes32 intentId,
        bytes32 stageKey,
        bytes32 chainKey,
        string calldata externalTxHash,
        address targetContract,
        bytes4 functionSelector,
        bytes32 protocolKey,
        uint256 amount
    ) external onlyRecorder whenNotPaused returns (uint16 stepIndex) {
        bytes memory externalTxHashBytes = bytes(externalTxHash);
        if (externalTxHashBytes.length == 0) revert EmptyExternalTxHash();

        bytes32 txHashRef = keccak256(externalTxHashBytes);
        stepIndex =
            recordStep(intentId, stageKey, chainKey, txHashRef, targetContract, functionSelector, protocolKey, amount);
        emit ExternalTransactionRecorded(intentId, stepIndex, chainKey, txHashRef, externalTxHash);
    }

    function updateIntentStatus(bytes32 intentId, uint8 status) external onlyRecorder whenNotPaused {
        if (status != STATUS_REGISTERED && status != STATUS_COMPLETED && status != STATUS_FAILED) {
            revert BadStatus(status);
        }

        Intent storage intent = intents[intentId];
        if (intent.status == 0) revert IntentNotRegistered(intentId);

        uint64 nowTs = uint64(block.timestamp);
        intent.status = status;
        intent.updatedAt = nowTs;
        emit IntentStatusUpdated(intentId, status, nowTs);
    }
}
