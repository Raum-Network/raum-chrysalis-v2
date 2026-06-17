// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title ArcReceiptNFT
 * @notice On-chain ERC-721 receipt minted on Arc Testnet for every successfully
 *         executed cross-chain intent.  Each token encodes the full provenance of
 *         the user's transaction: protocol, action, chains, amounts, route, and
 *         the destination-chain tx hash.
 *
 * Deployment: Arc Testnet (chain 5042002, gas token USDC)
 * Minting authority: Arc protocol operator (MINTER_ROLE)
 */
contract ArcReceiptNFT is ERC721, AccessControl {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    struct ReceiptData {
        string  intentId;
        address beneficiary;
        string  sourceChain;
        string  destinationChain;
        string  protocol;
        string  action;
        string  asset;
        string  amountIn;
        string  amountOut;
        string  routeKind;
        string  txHash;         // destination-chain execution tx hash
        string  destinationRecipient; // Stellar/Solana/EVM recipient on the destination chain
        uint256 mintedAt;
    }

    uint256 private _nextTokenId;

    /// tokenId → receipt data
    mapping(uint256 => ReceiptData) public receipts;

    /// intentId → tokenId (0 = not minted; real IDs start at 1)
    mapping(string => uint256) public intentToToken;

    // ── Events ──────────────────────────────────────────────────────────────

    event ReceiptMinted(
        uint256 indexed tokenId,
        string  indexed intentId,
        address indexed beneficiary,
        string  protocol,
        string  action,
        string  asset,
        string  amountIn,
        string  routeKind
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error AlreadyMinted(string intentId);
    error ZeroAddress();
    error EmptyIntentId();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address admin) ERC721("Arc Protocol Receipt", "ARC-RCPT") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    // ── External ─────────────────────────────────────────────────────────────

    /**
     * @notice Mint a receipt NFT for a completed intent.
     * @param beneficiary  Wallet that executed the intent — receives the NFT.
     * @param intentId     Unique intent ID from the Arc orchestrator (nanoid).
     * @param sourceChain  Source chain key (e.g. "ARC", "BASE_SEPOLIA").
     * @param destinationChain  Destination chain key.
     * @param protocol     Protocol adapter key (e.g. "ARB_AAVE_V3").
     * @param action       Action performed ("supply", "swap", "transfer", ...).
     * @param asset        Asset symbol ("USDC", "EURC", ...).
     * @param amountIn     Input amount as a display string, including unit when useful.
     * @param amountOut    Output amount as a display string, including unit when useful.
     * @param routeKind    Bridge route used ("GATEWAY", "CCTP_V2", "LOCAL", ...).
     * @param txHash       Destination-chain execution transaction hash.
     * @return tokenId     The newly minted ERC-721 token ID.
     */
    function mintReceipt(
        address beneficiary,
        string calldata intentId,
        string calldata sourceChain,
        string calldata destinationChain,
        string calldata protocol,
        string calldata action,
        string calldata asset,
        string calldata amountIn,
        string calldata amountOut,
        string calldata routeKind,
        string calldata txHash
    ) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        return _mintReceipt(
            beneficiary,
            intentId,
            sourceChain,
            destinationChain,
            protocol,
            action,
            asset,
            amountIn,
            amountOut,
            routeKind,
            txHash,
            ""
        );
    }

    /**
     * @notice Mint a receipt NFT and store the actual destination-chain recipient.
     * @dev The NFT owner remains an EVM address on Arc. Non-EVM recipients are
     *      stored as strings because Stellar and Solana addresses are not EVM addresses.
     */
    function mintReceiptV2(
        address beneficiary,
        string calldata intentId,
        string calldata sourceChain,
        string calldata destinationChain,
        string calldata protocol,
        string calldata action,
        string calldata asset,
        string calldata amountIn,
        string calldata amountOut,
        string calldata routeKind,
        string calldata txHash,
        string calldata destinationRecipient
    ) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        return _mintReceipt(
            beneficiary,
            intentId,
            sourceChain,
            destinationChain,
            protocol,
            action,
            asset,
            amountIn,
            amountOut,
            routeKind,
            txHash,
            destinationRecipient
        );
    }

    function _mintReceipt(
        address beneficiary,
        string memory intentId,
        string memory sourceChain,
        string memory destinationChain,
        string memory protocol,
        string memory action,
        string memory asset,
        string memory amountIn,
        string memory amountOut,
        string memory routeKind,
        string memory txHash,
        string memory destinationRecipient
    ) internal returns (uint256 tokenId) {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (bytes(intentId).length == 0) revert EmptyIntentId();
        if (intentToToken[intentId] != 0) revert AlreadyMinted(intentId);

        tokenId = ++_nextTokenId;
        _mint(beneficiary, tokenId);

        receipts[tokenId] = ReceiptData({
            intentId:         intentId,
            beneficiary:      beneficiary,
            sourceChain:      sourceChain,
            destinationChain: destinationChain,
            protocol:         protocol,
            action:           action,
            asset:            asset,
            amountIn:         amountIn,
            amountOut:        amountOut,
            routeKind:        routeKind,
            txHash:           txHash,
            destinationRecipient: destinationRecipient,
            mintedAt:         block.timestamp
        });

        intentToToken[intentId] = tokenId;

        emit ReceiptMinted(tokenId, intentId, beneficiary, protocol, action, asset, amountIn, routeKind);
    }

    // ── View ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns on-chain base64-encoded JSON metadata (ERC-721 tokenURI standard).
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        ReceiptData memory r = receipts[tokenId];

        // Build SVG artwork
        string memory svg = _buildSvg(tokenId, r);

        // Build JSON metadata
        string memory json = string(abi.encodePacked(
            '{"name":"Arc Receipt #', tokenId.toString(), '",',
            '"description":"On-chain proof of DeFi execution via Chrysalis V2. Protocol: ', r.protocol, ' | Action: ', r.action, ' | Asset: ', r.asset, '",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '",',
            '"attributes":[',
                '{"trait_type":"Protocol","value":"',      r.protocol,         '"},',
                '{"trait_type":"Action","value":"',        r.action,           '"},',
                '{"trait_type":"Asset","value":"',         r.asset,            '"},',
                '{"trait_type":"Amount In","value":"',     r.amountIn,         '"},',
                '{"trait_type":"Amount Out","value":"',    r.amountOut,        '"},',
                '{"trait_type":"Route","value":"',         r.routeKind,        '"},',
                '{"trait_type":"Source Chain","value":"',  r.sourceChain,      '"},',
                '{"trait_type":"Dest Chain","value":"',    r.destinationChain, '"},',
                '{"trait_type":"Destination Recipient","value":"', r.destinationRecipient, '"},',
                '{"trait_type":"Execution Tx","value":"',   r.txHash,           '"},',
                '{"trait_type":"Intent ID","value":"',     r.intentId,         '"},',
                '{"trait_type":"Minted At","value":',      r.mintedAt.toString(), '}',
            ']}'
        ));

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        ));
    }

    /**
     * @notice Returns total minted supply.
     */
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _buildSvg(uint256 tokenId, ReceiptData memory r) internal pure returns (string memory) {
        // Color scheme based on route
        (string memory bg, string memory accent) = _routeColors(r.routeKind);

        return string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
            '<defs>',
              '<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">',
                '<stop offset="0%" style="stop-color:', bg, ';stop-opacity:1"/>',
                '<stop offset="100%" style="stop-color:#0d0e14;stop-opacity:1"/>',
              '</linearGradient>',
            '</defs>',
            '<rect width="400" height="400" fill="url(#g)" rx="20"/>',
            '<rect x="1" y="1" width="398" height="398" fill="none" stroke="', accent, '" stroke-opacity="0.3" rx="20"/>',

            // Title
            '<text x="24" y="46" font-family="monospace" font-size="11" fill="', accent, '" opacity="0.7" font-weight="bold">ARC PROTOCOL RECEIPT</text>',
            '<text x="24" y="70" font-family="monospace" font-size="22" fill="#ffffff" font-weight="bold">#', tokenId.toString(), '</text>',

            // Protocol badge
            '<rect x="24" y="88" width="352" height="1" fill="', accent, '" opacity="0.2"/>',

            // Protocol line
            '<text x="24" y="116" font-family="monospace" font-size="10" fill="#6b7280">PROTOCOL</text>',
            '<text x="24" y="134" font-family="monospace" font-size="14" fill="#ffffff" font-weight="bold">', r.protocol, '</text>',

            // Action + asset
            '<text x="24" y="162" font-family="monospace" font-size="10" fill="#6b7280">ACTION</text>',
            '<text x="24" y="180" font-family="monospace" font-size="14" fill="', accent, '" font-weight="bold">', r.action, '</text>',

            '<text x="200" y="162" font-family="monospace" font-size="10" fill="#6b7280">ASSET</text>',
            '<text x="200" y="180" font-family="monospace" font-size="14" fill="#ffffff" font-weight="bold">', r.asset, '</text>',

            // Amounts
            '<text x="24" y="210" font-family="monospace" font-size="10" fill="#6b7280">AMOUNT IN</text>',
            '<text x="24" y="228" font-family="monospace" font-size="13" fill="#ffffff">', r.amountIn, '</text>',

            '<text x="200" y="210" font-family="monospace" font-size="10" fill="#6b7280">AMOUNT OUT</text>',
            '<text x="200" y="228" font-family="monospace" font-size="13" fill="#10b981">', r.amountOut, '</text>',

            // Route
            '<text x="24" y="258" font-family="monospace" font-size="10" fill="#6b7280">ROUTE</text>',
            '<text x="24" y="276" font-family="monospace" font-size="12" fill="', accent, '">', r.routeKind, '</text>',

            // Chains
            '<text x="24" y="306" font-family="monospace" font-size="10" fill="#6b7280">FROM</text>',
            '<text x="24" y="322" font-family="monospace" font-size="11" fill="#ffffff">', r.sourceChain, '</text>',

            '<text x="200" y="306" font-family="monospace" font-size="10" fill="#6b7280">TO</text>',
            '<text x="200" y="322" font-family="monospace" font-size="11" fill="#ffffff">', r.destinationChain, '</text>',

            // Divider + intent id (truncated)
            '<rect x="24" y="342" width="352" height="1" fill="', accent, '" opacity="0.15"/>',
            '<text x="24" y="364" font-family="monospace" font-size="9" fill="#4b5563">INTENT: ', r.intentId, '</text>',
            '<text x="24" y="382" font-family="monospace" font-size="9" fill="#374151">CHRYSALIS V2  |  ARC TESTNET</text>',

            '</svg>'
        ));
    }

    function _routeColors(string memory routeKind) internal pure returns (string memory bg, string memory accent) {
        bytes32 rk = keccak256(bytes(routeKind));
        if (rk == keccak256(bytes("GATEWAY")))  return ("#0a2018", "#10b981");
        if (rk == keccak256(bytes("CCTP_V2")))  return ("#0a1428", "#3b82f6");
        if (rk == keccak256(bytes("BRIDGEKIT"))) return ("#160a28", "#8b5cf6");
        if (rk == keccak256(bytes("LOCAL")))    return ("#1c1500", "#f59e0b");
        return ("#0d0e14", "#6b7280");
    }

    // ── ERC165 ───────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
