# Latency

How long after a write does everyone else see it? That number is the whole
product, so this page gives the measurement, the method, and the parts that
did not go the way we expected.

## The result

Twelve samples against the live contract on Monad testnet, August 2026.
Every millisecond below is measured, not modelled.

| read path | min | **median** | max | mean |
| --- | ---: | ---: | ---: | ---: |
| `monadLogs` subscription, first sighting | 575 | **889** | 1710 | 975 |
| `monadLogs` subscription, waiting for `Finalized` | 1181 | 1439 | 2348 | 1517 |
| 250ms `eth_getLogs` poll | 1021 | **1524** | 4198 | 1866 |

**The subscription is about 1.7× faster at the median — 635ms.**

The tail matters more than the median for anything interactive, and that is
where the gap is widest: the poll's slowest sample took **4198ms**, the
subscription's **1710ms**. A player does not notice a good median. They
notice the move that seemed to hang.

## What did not hold up

An earlier six-sample run put the subscription at 781ms against 1666ms — a
2.13× improvement — and suggested that even waiting for `Finalized` beat the
poll outright. **Neither survived a bigger sample.**

Across three runs the improvement ranged from 1.37× to 2.13×, settling near
1.7× on the largest. And `Finalized` (1439ms) against the poll (1524ms) is a
wash: the subscription won only 8 of 12 individual samples. So the honest
claim is narrower than the first one:

> Reading at `Proposed` is meaningfully faster. Reading at `Finalized` is
> about the same speed as polling — you take it for the tail behaviour and
> the RPC load, not for the median.

If you need finality, the subscription is still worth using. Just not because
it is faster.

## Method

Both paths watch the **same transaction**, in the same process, in one run.
There is no cross-run comparison, so a slow minute on the network cannot
flatter one path over the other.

- Each sample is a real `broadcast` call — 30k gas, a genuine transaction.
- `t0` is the moment `sendRawTransaction` returns.
- Both paths use the identical server-side topic filter, so the only variable
  is the transport.
- Samples run sequentially, six seconds apart.

Reproduce it:

```bash
node --dns-result-order=ipv4first --no-network-family-autoselection \
     scripts/bench-latency.mjs 12
```

Absolute numbers carry the tester's network — these were taken from India
against the public RPC. **The delta is the portable part.** Run it yourself
before quoting it.

## Why the subscription is faster

`eth_getLogs` can only return a log once the block has been executed and is
queryable. `monadLogs` publishes as soon as the node has *speculatively*
executed the block, which is roughly a second earlier. On top of that, a
250ms poll adds up to 250ms of its own just waiting for the next tick — the
poll's wide spread (1021–4198ms) is that interval beating against block time.

## The catch, and why it is a real choice

Every log is delivered **four times** — once per commit state:

```
Proposed  ->  Voted  ->  Finalized  ->  Verified
```

`Proposed` means the node executed the block speculatively, before consensus
decided the block's fate. Blocks at that stage can still lose: a competing
block finalizing at the same height quietly supersedes them, and **no event
is published to say so**. There is no rejection message to listen for.

So reading at `Proposed` trades certainty for roughly 550ms. For presence and
cursors that is obviously right — the next update corrects anything wrong
within a frame. For a move that pays out money, it is not.

Pick per connection:

```ts
// fast: react the moment the node has executed it (default)
MonSocket.connect({ key, contract, realtime: true })

// certain: wait for consensus
MonSocket.connect({
  key, contract,
  realtime: { minCommitState: "Finalized" },
})
```

Every event carries the `commitState` it was delivered at, so an app can also
show its own confidence:

```ts
room.onStateChange(({ state, commitState }) => {
  render(state, { settled: commitState === "Finalized" })
})
```

monsocket deduplicates the four deliveries for you — a callback fires once
per event, not four times.

## Falling back

`realtime: true` cannot break a room. If the environment has no WebSocket, if
the node refuses the subscription, or if the connection drops mid-game, the
room resumes polling and keeps going, then returns to the subscription when
it can. A room polls while the subscription is being established, so the
opening seconds are never dark.

Because a quiet room and a dead socket both produce silence, the connection
is probed rather than assumed — a stalled socket is detected even when
nothing is happening in the room.

::: tip Node consumers
Node's built-in `WebSocket` fails this handshake (close code 1006). Browsers
are fine. On Node, pass an implementation:

```ts
import WebSocket from "ws"
MonSocket.connect({ key, contract, realtime: { WebSocketImpl: WebSocket } })
```

Without it the client silently stays on polling — which works, but you will
wonder why it is slow.
:::
