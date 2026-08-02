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
    /// First address to ever write a room's state — set once, immutable.
    /// Apps use it as the room's referee (e.g. deterministic player roles).
    mapping(bytes32 => address) public roomCreator;
    /// Every room that ever held state, in creation order — the lobby index.
    bytes32[] public rooms;
    /// v1 stake escrow: skin in the game, self-custody. Each staker can
    /// only ever pull back their OWN stake — nothing here can be rugged.
    /// (Validated winner-takes-pot needs structured onchain game state —
    /// that's the roadmap, not this primitive.)
    mapping(bytes32 => mapping(address => uint256)) public stakeOf;
    mapping(bytes32 => uint256) public pot;

    event Staked(bytes32 indexed room, address indexed player, uint256 amount);
    event Refunded(bytes32 indexed room, address indexed player, uint256 amount);

    function broadcast(bytes32 room, bytes calldata data) external {
        emit Presence(room, msg.sender, data);
    }

    function send(bytes32 room, string calldata name, bytes calldata data) external {
        emit Message(room, msg.sender, name, data);
    }

    function roomCount() external view returns (uint256) {
        return rooms.length;
    }

    function stake(bytes32 room) external payable {
        require(msg.value > 0, "no value");
        stakeOf[room][msg.sender] += msg.value;
        pot[room] += msg.value;
        emit Staked(room, msg.sender, msg.value);
    }

    function refund(bytes32 room) external {
        uint256 amt = stakeOf[room][msg.sender];
        require(amt > 0, "nothing staked");
        stakeOf[room][msg.sender] = 0;
        pot[room] -= amt;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "transfer failed");
        emit Refunded(room, msg.sender, amt);
    }

    function setState(bytes32 room, bytes calldata data) external {
        if (roomCreator[room] == address(0)) {
            roomCreator[room] = msg.sender;
            rooms.push(room);
        }
        uint64 seq = ++stateSeq[room];
        roomState[room] = data;
        emit StateChange(room, msg.sender, seq, data);
    }
}
