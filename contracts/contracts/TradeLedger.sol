// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title TradeLedger
 * @notice Append-only, hash-chained record of every decision an agent takes.
 *
 * Each entry commits to the previous head, so the record cannot be reordered,
 * back-filled or quietly deleted. A trade is only possible if the trader anchors
 * it, which means the ledger sees the winning trades and the losing ones, and the
 * refusals too.
 *
 * newHead = keccak256(prevHead ‖ decisionHash ‖ outcomeHash ‖ timestamp ‖ sequence)
 *
 * The preimage of decisionHash is defined off-chain (see agent/src/ledger.ts) and
 * covers the full market snapshot, the model's reasoning and the intended order.
 */
contract TradeLedger {
    struct Entry {
        bytes32 prev;
        bytes32 decision;
        bytes32 outcome;
        uint64 ts;
        uint32 seq;
    }

    error NotWriter();
    error WriterAlreadySet();

    event Anchored(
        uint32 indexed seq,
        bytes32 indexed head,
        bytes32 prev,
        bytes32 decision,
        bytes32 outcome,
        uint64 ts
    );

    address public owner;
    address public writer;
    bytes32 public head;
    uint32 public count;

    mapping(bytes32 => Entry) private _entries;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotWriter();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setWriter(address w) external onlyOwner {
        if (writer != address(0)) revert WriterAlreadySet();
        writer = w;
    }

    /**
     * @notice Append one decision to the chain.
     * @dev Only the trader may write, so the record is produced by the exact same
     *      transaction that moved the money.
     */
    function anchor(bytes32 decisionHash, bytes32 outcomeHash) external returns (bytes32 newHead) {
        if (msg.sender != writer) revert NotWriter();

        uint32 seq = ++count;
        bytes32 prev = head;
        uint64 ts = uint64(block.timestamp);

        newHead = keccak256(abi.encodePacked(prev, decisionHash, outcomeHash, ts, seq));

        _entries[newHead] = Entry({prev: prev, decision: decisionHash, outcome: outcomeHash, ts: ts, seq: seq});
        head = newHead;

        emit Anchored(seq, newHead, prev, decisionHash, outcomeHash, ts);
    }

    function entry(bytes32 entryHash) external view returns (Entry memory) {
        return _entries[entryHash];
    }

    /// @notice Independent verification helper. Recomputes one link from its parts.
    function recompute(bytes32 prev, bytes32 decisionHash, bytes32 outcomeHash, uint64 ts, uint32 seq)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(prev, decisionHash, outcomeHash, ts, seq));
    }
}
