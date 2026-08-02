# Where monsocket goes

## Thesis

Monad can make realtime onchain applications feel alive, but developers still
need to solve the same low-level multiplayer plumbing: burner signing, nonce
handling, log streaming, room state, interpolation, and spectator reads.

monsocket packages that work into a small SDK for rooms, presence, events,
and shared state.

## What gets built on top

- **The Onchain Arcade**: instantly playable multiplayer games on Monad,
  starting with The Vault.
- **Community worlds**: persistent rooms for events, token-gated spaces, and
  proximity-style multiplayer experiences.
- **Agent coordination rooms**: ordered, attributable event streams for
  autonomous agents and humans.
- **Live onchain spectacles**: races, auctions, game shows, and other events
  where watching should be free.

## Roadmap

1. **Now**: contract, client SDK, docs, and The Vault on Monad testnet.
2. **Batching**: pack multiple inputs into one transaction to reduce gas and
   raise effective tick rate.
3. **Sponsored sessions**: let apps fund sessions so players do not manage
   MON before playing.
4. **Low-latency relay**: optional hosted read path for teams that want
   websocket delivery over raw log polling.
5. **Onchain Arcade**: shared identity, leaderboards, and multiple games on
   the same room layer.

## Positioning

monsocket is ideal for co-op games, board games, collaborative apps, live
events, agent coordination, and experiences where signed realtime state
matters. It is not trying to be netcode for twitch shooters.
