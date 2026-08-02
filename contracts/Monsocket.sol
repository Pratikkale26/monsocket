// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Monsocket — realtime multiplayer rooms on Monad.
/// @notice Socket.io-shaped primitives as one contract: presence broadcasts
///         and messages ride in event logs (the cheapest bytes on an EVM —
///         nothing touches storage), shared room state is a storage slot so
///         late joiners can read it without replaying history. Rooms are
///         open topics: any address can publish into any room id. Monad's
///         300ms blocks make the log stream fast enough to feel live.
contract Monsocket {
    /// A player's self-reported realtime state (position, cursor, …).
    event Presence(bytes32 indexed room, address indexed player, bytes data);
    /// A named ephemeral event (chat, emote, …) — log-only, zero storage.
    event Message(bytes32 indexed room, address indexed player, string name, bytes data);
    /// Shared room state changed (last-write-wins, seq-ordered).
    event StateChange(bytes32 indexed room, address indexed player, uint64 seq, bytes data);

    mapping(bytes32 => bytes) public roomState;
    mapping(bytes32 => uint64) public stateSeq;

    function broadcast(bytes32 room, bytes calldata data) external {
        emit Presence(room, msg.sender, data);
    }

    function send(bytes32 room, string calldata name, bytes calldata data) external {
        emit Message(room, msg.sender, name, data);
    }

    function setState(bytes32 room, bytes calldata data) external {
        uint64 seq = ++stateSeq[room];
        roomState[room] = data;
        emit StateChange(room, msg.sender, seq, data);
    }
}
