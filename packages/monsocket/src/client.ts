/**
 * monsocket — Socket.io for Monad.
 *
 * A rooms/broadcast/subscribe API on a Monad L1 transport:
 *  - writes: raw EIP-1559 transactions signed locally by a burner key with a
 *    LOCAL nonce counter and measured gas limits (Monad bills gas_limit, not
 *    gas_used — padding is real money), fired without simulation.
 *  - reads: the `monadLogs` subscription when `realtime` is on, falling back
 *    to a getLogs poll against `latest` — which on Monad is PROPOSED state,
 *    speculative and one block ahead of finality.
 *    The filter is applied at the node (room id is an indexed topic), so a
 *    client never downloads other rooms' traffic.
 *  - rooms are open bytes32 topics; presence and messages live purely in
 *    event logs (no storage), shared state sits in one storage slot so a
 *    late joiner reads it directly instead of replaying history.
 * No join transaction exists — reading a room is free, so spectating costs
 * nothing and needs no funded wallet.
 */
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  hexToString,
  http,
  keccak256,
  numberToHex,
  stringToHex,
  toBytes,
  type Hex,
  type PublicClient,
  type RpcLog,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ABI } from "./abi.js";
import {
  LogStream,
  ROOM_EVENT_TOPICS,
  type CommitState,
  type RealtimeOpts,
  type StreamLog,
} from "./realtime.js";

/** The Monsocket contract deployed on Monad testnet. Rooms are open bytes32
 *  topics, so anyone can join this one — or pass their own deployment to
 *  `connect()`. Named explicitly on purpose: a default address baked into a
 *  published package can never be changed without breaking installs. */
export const MONSOCKET_TESTNET_CONTRACT =
  "0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4" as const;

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  contracts: {
    // Multicall3 at its canonical cross-chain address — verified deployed on
    // Monad testnet. Lets the lobby read every room in one eth_call.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/** Fixed gas limits per action — tuned tight because Monad charges the
 *  limit. Presence/messages are log-only (~26k real); setState touches
 *  storage for a dynamic bytes value. */
/** Every action that costs gas. */
export type GasAction = "broadcast" | "send" | "setState" | "stake" | "refund";

/** Per-action gas limits. `setStateCreate` is the cold path — the write that
 *  brings a room into existence. */
export type GasLimits = Record<GasAction | "setStateCreate", bigint>;

const GAS: Omit<GasLimits, "setStateCreate"> = {
  broadcast: 30_000n,
  send: 36_000n,
  // Writing a room's state for the FIRST time is a different animal from
  // updating it: it pays three cold storage slots (state, seq, creator) plus
  // a push into the lobby registry, and it scales per 32 bytes of payload.
  // Measured on testnet against the live contract: creating a room costs
  // 210k with the vault's 57-byte seed, 239k at 81 bytes, and a real tx at a
  // 215k limit reverts without storing anything. Updating an existing room
  // costs ~87k.
  //
  // One shared 215k limit therefore left the vault's room creation with 2%
  // headroom — any growth in the seed would have broken it silently — while
  // charging every ordinary move ~2.5x what it needs. Monad bills the limit,
  // so the padding was a permanent tax and the margin was a landmine.
  setState: 120_000n,
  stake: 95_000n,
  refund: 75_000n,
} as const;

/** Cold-path limit for the write that brings a room into existence. */
const GAS_SETSTATE_CREATE = 320_000n;

const DEFAULT_GAS: GasLimits = { ...GAS, setStateCreate: GAS_SETSTATE_CREATE };

/** These limits are right for payloads the size of The Vault's. They are not
 *  right for everyone: `setState` at 120k covers a measured ~87k warm update
 *  of a 57-byte state, and an app with a few hundred bytes of shared state
 *  will exceed it. Monad defers validation, so that transaction is INCLUDED
 *  and then fails — no throw, no rejected promise, nothing in the console.
 *  Measure your own payload with `measureGas()` and pass `gas` to connect(). */
export type GasOverrides = Partial<GasLimits>;

const PRIORITY = 2_000_000_000n;

// --- fees ------------------------------------------------------------------
// Monad's minimum base fee is 100 gwei. A single hardcoded cap just above it
// is a cliff: if the base fee ever climbs past it, every write from every
// client fails at once and the SDK has no way to notice. So the cap tracks
// the observed base fee, with a floor to stay cheap and a ceiling so a fee
// spike can never quietly drain a player's burner.
const FEE_FLOOR = 150_000_000_000n; // 150 gwei — the old fixed value
const FEE_CEILING = 2_000_000_000_000n; // 2000 gwei — a wall, not a target
const FEE_MULTIPLIER = 2n; // headroom over base for a few blocks of drift
const FEE_TTL_MS = 10_000; // how long a sampled base fee is trusted

const POLL_MS = 250;
// --- polling backoff -------------------------------------------------------
// A bare retry every 250ms through an RPC outage is how a blip becomes an
// outage: every client hammers the endpoint four times a second and earns a
// harder rate limit. Back off, and recover the moment a poll succeeds.
const BACKOFF_MAX_MS = 8_000;
/** Cap on the dedupe set. A room seeing more than this many distinct logs
 *  between evictions is not a room, it is a firehose. */
const SEEN_MAX = 4096;

export interface PresenceEntry<P> {
  player: string;
  data: P;
  seq: number;
  at: number;
  /** How settled the block carrying this event was when it was delivered.
   *  Only present on the realtime path; `undefined` means it came off the
   *  polling fallback, which reads already-executed state. */
  commitState?: CommitState;
}
type PresenceCb<P> = (e: PresenceEntry<P>) => void;
type MessageCb<M> = (e: {
  player: string;
  name: string;
  data: M;
  commitState?: CommitState;
}) => void;
type StateCb<T> = (e: {
  player: string;
  seq: number;
  state: T;
  commitState?: CommitState;
}) => void;

/** Something went wrong after a write left the building. */
export interface MonSocketError {
  /** `send` — the node rejected the transaction outright.
   *  `revert` — it was INCLUDED and then failed, which on Monad is a normal
   *  outcome rather than an exception, and is invisible unless checked. */
  kind: "send" | "revert";
  action: GasAction;
  message: string;
  hash?: Hex;
  cause?: unknown;
}

export interface ConnectOpts {
  key: Hex; // burner private key — signs every action, no popups
  contract: Hex;
  rpc?: string;
  /** Opt in to the `monadLogs` subscription instead of the polling read path.
   *  Roughly halves write→observe. Any failure — no WebSocket available, a
   *  refused upgrade, a dropped connection — falls back to polling on its own,
   *  so turning this on cannot make a room stop working. */
  realtime?: boolean | RealtimeOpts;
  /** Override the built-in gas limits. Required for any app whose payloads
   *  are bigger than The Vault's — see `GasOverrides`. */
  gas?: GasOverrides;
  /** Called when a write fails, including when it fails *after* being
   *  included. Without this, a reverted `setState` is silent: the room simply
   *  never changes and nothing explains why. */
  onError?: (e: MonSocketError) => void;
  /** Which actions to check the receipt of. Durable writes are checked by
   *  default; presence and messages are not, because they cost an extra RPC
   *  call each and heal on the next beat anyway. */
  confirm?: Partial<Record<GasAction, boolean>>;
}

/** Whatever the node actually said, in one line. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0];
  return String(err);
}

interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** localStorage where it exists and is usable. Private-mode browsers throw on
 *  access rather than simply lacking it, so this is a try, not a check. */
function safeStorage(): KeyValueStore | null {
  try {
    const s = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    if (!s) return null;
    s.getItem("monsocket:probe");
    return s;
  } catch {
    return null;
  }
}

interface LockManager {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

/** The Web Locks API — a real mutex across a browser's tabs. Absent in Node,
 *  where a process has no siblings to race with. */
function webLocks(): LockManager | null {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  return typeof nav?.locks?.request === "function" ? nav.locks : null;
}

/** Ephemeral traffic heals itself — the next broadcast corrects it, so paying
 *  a receipt lookup per presence update is a poor trade. A durable write that
 *  reverts is a different thing: nothing corrects it and nobody is told. */
const CONFIRM_DEFAULT: Record<GasAction, boolean> = {
  broadcast: false,
  send: false,
  setState: true,
  stake: true,
  refund: true,
};

export class MonSocket {
  readonly account: PrivateKeyAccount;
  readonly address: Hex;
  readonly client: PublicClient;
  readonly contract: Hex;
  /** The shared subscription, or null when this client polls. One socket
   *  serves every room — several open cabinets are still one connection. */
  readonly stream: LogStream | null;
  /** The gas limit used per action, after any overrides. */
  readonly gas: GasLimits;
  private nonce: number | null = null;
  private readonly onError: ((e: MonSocketError) => void) | undefined;
  private readonly confirm: Record<GasAction, boolean>;
  private baseFee = FEE_FLOOR;
  private baseFeeAt = 0;
  private baseFeePromise: Promise<void> | null = null;

  private constructor(opts: ConnectOpts) {
    this.account = privateKeyToAccount(opts.key);
    this.address = this.account.address;
    this.contract = opts.contract;
    this.gas = { ...DEFAULT_GAS, ...opts.gas };
    this.onError = opts.onError;
    this.confirm = { ...CONFIRM_DEFAULT, ...opts.confirm };
    const rpc = opts.rpc ?? monadTestnet.rpcUrls.default.http[0];
    this.client = createPublicClient({
      chain: monadTestnet,
      // Batching folds same-tick reads into one HTTP request. `retryCount`
      // is cut from viem's default of 3 because the read path already
      // retries: a failed poll changes nothing (fromBlock is untouched) and
      // the next tick tries again, so transport-level retries only multiply
      // the load on an endpoint that is already unwell — measured at 4 HTTP
      // requests per failed poll before this. One retry still covers a blip
      // on a one-off read like listRoomIds.
      transport: http(rpc, { batch: true, retryCount: 1 }),
    });
    void this.refreshBaseFee();
    const rt = opts.realtime;
    const stream = rt
      ? new LogStream(opts.contract, rpc, rt === true ? {} : rt)
      : null;
    // No WebSocket in this environment is not an error, it is the polling
    // path — which is exactly what a caller who never asked for realtime got.
    this.stream = stream?.available ? stream : null;
  }

  static connect(opts: ConnectOpts): MonSocket {
    return new MonSocket(opts);
  }

  async balance(): Promise<bigint> {
    return this.client.getBalance({ address: this.address });
  }

  private noncePromise: Promise<number> | null = null;

  private get nonceKey(): string {
    return `monsocket:nonce:${this.address.toLowerCase()}`;
  }

  /** Hand out the next nonce.
   *
   *  A single in-memory counter is only correct while it is the only counter.
   *  It is not: an arcade shares one burner across every cabinet, and two
   *  browser tabs are two independent counters on one account. They hand out
   *  the same number, and one of the two transactions is simply lost —
   *  measured at one write in four under simultaneous load.
   *
   *  So the counter is shared through storage and allocation is serialized
   *  with a cross-tab lock. Where neither exists (Node, or a browser without
   *  the Locks API) this degrades to the in-memory counter, which is exactly
   *  right there because there are no other tabs to race.
   *
   *  Seeded from `pending` rather than `latest` so a transaction already in
   *  flight is counted rather than handed out twice. */
  private async nextNonce(): Promise<number> {
    const allocate = async (): Promise<number> => {
      const store = safeStorage();
      let next = this.nonce;
      if (store) {
        // Read the absence explicitly. `Number(null)` is 0, and 0 is a
        // perfectly finite nonce — taking it would seed a fresh browser at
        // zero and have every write rejected.
        const raw = store.getItem(this.nonceKey);
        if (raw !== null) {
          const shared = Number(raw);
          // Another tab may have moved further ahead than this one has.
          if (Number.isInteger(shared) && shared >= 0 && (next === null || shared > next))
            next = shared;
        }
      }
      if (next === null) {
        if (!this.noncePromise) {
          this.noncePromise = this.client
            .getTransactionCount({ address: this.address, blockTag: "pending" })
            .finally(() => (this.noncePromise = null));
        }
        next = await this.noncePromise;
      }
      this.nonce = next + 1;
      store?.setItem(this.nonceKey, String(next + 1));
      return next;
    };
    const locks = webLocks();
    return locks ? locks.request(this.nonceKey, allocate) : allocate();
  }

  /** Forget the counter everywhere, so the next write reseeds from the
   *  chain. Both tabs must forget: a stale shared value is worse than none. */
  private resetNonce() {
    this.nonce = null;
    try {
      safeStorage()?.removeItem(this.nonceKey);
    } catch {
      /* storage unavailable — the in-memory reset is enough */
    }
  }

  /** Sample the base fee. Never on the hot path — a write uses the last
   *  sample and kicks off a refresh if it has gone stale, because adding an
   *  RPC round trip to every move would cost more latency than the adaptive
   *  cap is worth. */
  private async refreshBaseFee(): Promise<void> {
    if (this.baseFeePromise) return this.baseFeePromise;
    this.baseFeePromise = (async () => {
      try {
        const block = await this.client.getBlock({ blockTag: "latest" });
        if (block.baseFeePerGas != null) {
          this.baseFee = block.baseFeePerGas;
          this.baseFeeAt = Date.now();
        }
      } catch {
        // Keep the previous sample: a stale cap beats no cap.
      } finally {
        this.baseFeePromise = null;
      }
    })();
    return this.baseFeePromise;
  }

  /** What to cap this transaction's fee at. */
  private feeCap(): bigint {
    if (Date.now() - this.baseFeeAt > FEE_TTL_MS) void this.refreshBaseFee();
    const wanted = this.baseFee * FEE_MULTIPLIER + PRIORITY;
    if (wanted < FEE_FLOOR) return FEE_FLOOR;
    return wanted > FEE_CEILING ? FEE_CEILING : wanted;
  }

  private fail(e: MonSocketError) {
    try {
      this.onError?.(e);
    } catch {
      /* a throwing error handler is not the transport's problem */
    }
  }

  /** Estimate what an action really costs with YOUR payload.
   *
   *  Monad bills the limit, so this is not a formality: too low reverts
   *  silently, too high is a permanent tax on every move. The default limits
   *  are sized for The Vault; anything with a larger shared state must
   *  measure and pass `gas` to connect().
   *
   *      const gas = await sock.measureGas("setState", [roomId, payload])
   */
  async measureGas(
    fn: GasAction,
    args: readonly unknown[],
    opts: { value?: bigint; headroom?: number } = {},
  ): Promise<bigint> {
    // Cast wholesale: `stake` is payable and the rest are not, so across the
    // union viem narrows `value` to undefined and the object stops typing.
    const estimate = await this.client.estimateContractGas({
      address: this.contract,
      abi: ABI,
      functionName: fn,
      args,
      account: this.account,
      value: opts.value ?? 0n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const pct = BigInt(Math.round((opts.headroom ?? 0.1) * 100));
    return estimate + (estimate * pct) / 100n;
  }

  /** Sign + fire one contract call using the local nonce counter. Returns
   *  the tx hash without waiting for inclusion — realtime writes are
   *  fire-and-forget; the log stream is the acknowledgement.
   *
   *  Inclusion is not success. Monad validates late, so a transaction can be
   *  mined and still have reverted; durable actions therefore have their
   *  receipt checked in the background and report through `onError`. */
  async write(
    fn: GasAction,
    args: readonly unknown[],
    value = 0n,
    gas?: bigint,
  ): Promise<Hex> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = encodeFunctionData({ abi: ABI, functionName: fn, args: args as any });
    const limit = gas ?? this.gas[fn];

    const send = async (): Promise<Hex> => {
      const serialized = await this.account.signTransaction({
        to: this.contract,
        value,
        data,
        nonce: await this.nextNonce(),
        gas: limit,
        maxFeePerGas: this.feeCap(),
        maxPriorityFeePerGas: PRIORITY,
        chainId: monadTestnet.id,
        type: "eip1559",
      });
      return this.client.sendRawTransaction({ serializedTransaction: serialized });
    };

    let hash: Hex;
    try {
      hash = await send();
    } catch (err) {
      // Nonce drift — a dropped transaction, or the other tab got there
      // first. Resync and retry exactly once: the second failure is real,
      // and an unbounded retry on a shared burner is a loop.
      this.resetNonce();
      try {
        hash = await send();
      } catch (err2) {
        this.resetNonce();
        this.fail({
          kind: "send",
          action: fn,
          message: `${fn} was rejected: ${errText(err2)}`,
          cause: err2 ?? err,
        });
        throw err2;
      }
    }
    if (this.confirm[fn]) void this.checkReceipt(hash, fn);
    return hash;
  }

  /** Watch a durable write land, and say so if it landed badly. */
  private async checkReceipt(hash: Hex, action: GasAction) {
    try {
      const receipt = await this.client.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
      });
      if (receipt.status === "success") return;
      this.fail({
        kind: "revert",
        action,
        hash,
        message:
          `${action} was included but reverted. The usual cause is a gas ` +
          `limit too low for the payload — Monad bills the limit and ` +
          `validates late, so this fails silently. Try measureGas("${action}", …).`,
      });
    } catch {
      // Never seeing a receipt is not the same as reverting — the log stream
      // is still the source of truth, so this stays quiet.
    }
  }

  /** Same room name → same room id, on every client. */
  roomId(name: string): Hex {
    return keccak256(toBytes(name));
  }

  /** Lobby index: the last `limit` rooms ever created, newest first.
   *
   *  One `eth_call` through Multicall3, not one per room. Awaiting inside a
   *  loop made this 25 sequential round-trips for 24 rooms — the hub's load
   *  time and the leaderboard's. Firing them concurrently instead is worse,
   *  not better: the public RPC limits requests to 15/sec and a burst trips
   *  it outright. Aggregating on-chain is the only version that is both fast
   *  and polite. */
  async listRoomIds(limit = 24): Promise<Hex[]> {
    const count = Number(
      (await this.client.readContract({
        address: this.contract,
        abi: ABI,
        functionName: "roomCount",
        args: [],
      })) as bigint,
    );
    const from = Math.max(0, count - limit);
    const indices: bigint[] = [];
    for (let i = count - 1; i >= from; i--) indices.push(BigInt(i));
    if (indices.length === 0) return [];

    const calls = indices.map((i) => ({
      address: this.contract,
      abi: ABI,
      functionName: "rooms" as const,
      args: [i] as const,
    }));
    try {
      const results = await this.client.multicall({
        contracts: calls,
        allowFailure: false,
      });
      return results as Hex[];
    } catch {
      // No Multicall3 on this deployment. Fall back to reading them one at a
      // time — slow, but rate-limit safe, which concurrency would not be.
      const ids: Hex[] = [];
      for (const i of indices) {
        ids.push(
          (await this.client.readContract({
            address: this.contract,
            abi: ABI,
            functionName: "rooms",
            args: [i],
          })) as Hex,
        );
      }
      return ids;
    }
  }

  /** Read any room's shared state without joining — no tx, no membership. */
  async peekState<T>(roomId: Hex): Promise<T | null> {
    const raw = (await this.client.readContract({
      address: this.contract,
      abi: ABI,
      functionName: "roomState",
      args: [roomId],
    })) as Hex;
    if (!raw || raw === "0x") return null;
    try {
      return JSON.parse(hexToString(raw)) as T;
    } catch {
      return null;
    }
  }

  /** v1 stake escrow: put MON in the room's pot (self-refund only). */
  async stakeRoom(roomId: Hex, amountWei: bigint): Promise<Hex> {
    return this.write("stake", [roomId], amountWei);
  }

  /** Pull YOUR stake back out — nobody else ever can. */
  async refundStake(roomId: Hex): Promise<Hex> {
    return this.write("refund", [roomId]);
  }

  async potOf(roomId: Hex): Promise<bigint> {
    return (await this.client.readContract({
      address: this.contract,
      abi: ABI,
      functionName: "pot",
      args: [roomId],
    })) as bigint;
  }

  async myStakeIn(roomId: Hex): Promise<bigint> {
    return (await this.client.readContract({
      address: this.contract,
      abi: ABI,
      functionName: "stakeOf",
      args: [roomId, this.address],
    })) as bigint;
  }

  /** The room's onchain referee: the first address that ever wrote its
   *  state. Immutable — every client reads the same answer forever. */
  async creatorOf(roomId: Hex): Promise<string | null> {
    const a = (await this.client.readContract({
      address: this.contract,
      abi: ABI,
      functionName: "roomCreator",
      args: [roomId],
    })) as Hex;
    return a && a !== "0x0000000000000000000000000000000000000000"
      ? a.toLowerCase()
      : null;
  }

  /** Join is free — there is no join transaction. Pass `initialState` to
   *  seed a brand-new room's shared state. */
  async joinOrCreate<T, P, M>(
    name: string,
    opts: { initialState?: T; readOnly?: boolean } = {},
  ): Promise<Room<T, P, M>> {
    const room = new Room<T, P, M>(this, this.roomId(name), name);
    const existing = await room.getState();
    if (existing === null && opts.initialState !== undefined && !opts.readOnly) {
      // Bringing the room into existence — the expensive cold write. This is
      // the one write a player cannot recover from silently: if it fails they
      // are sitting in a room that does not exist, so it reports rather than
      // being dropped on the floor.
      this.write(
        "setState",
        [room.id, stringToHex(JSON.stringify(opts.initialState))],
        0n,
        this.gas.setStateCreate,
      ).catch(() => {
        /* already reported through onError by write() */
      });
    }
    return room;
  }
}

export class Room<T = unknown, P = unknown, M = unknown> {
  private presenceCbs: PresenceCb<P>[] = [];
  private messageCbs: { name?: string; cb: MessageCb<M> }[] = [];
  private stateCbs: StateCb<T>[] = [];
  private fromBlock: bigint | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Consecutive failed polls, and the time before which not to try again.
   *  Without this the fixed interval retries straight through an outage. */
  private failures = 0;
  private backoffUntil = 0;
  /** Set once a callback has asked for events, so the feed starts once. */
  private started = false;
  private detachStream: (() => void) | null = null;
  /** Logs already delivered, keyed by transactionHash:logIndex.
   *
   *  Both read paths funnel through here and both need it. The subscription
   *  republishes each log once per commit state — four copies of every move —
   *  and a fallback from the socket to the poll re-reads a block the socket
   *  had already delivered. The key deliberately avoids `blockId`: only the
   *  subscription supplies one, so it could never match the poll's view of
   *  the same log. */
  private seen = new Set<string>();
  /** Has this room's state ever been observed to exist? Until it has, a write
   *  might be the one that creates the room and must carry the cold-path gas
   *  limit — guessing low there doesn't cost less, it reverts. */
  private stateSeen = false;

  private sock: MonSocket;
  readonly id: Hex;
  readonly name: string;

  constructor(sock: MonSocket, id: Hex, name: string) {
    this.sock = sock;
    this.id = id;
    this.name = name;
  }

  /** Publish this player's realtime state (position, …) — one onchain tx. */
  async broadcast(data: P): Promise<void> {
    await this.sock.write("broadcast", [this.id, stringToHex(JSON.stringify(data))]);
  }

  /** Emit a named ephemeral event (chat, emote…) — log-only, no storage. */
  async emit(name: string, data: M): Promise<void> {
    await this.sock.write("send", [this.id, name, stringToHex(JSON.stringify(data))]);
  }

  /** Write the shared room state (last-write-wins, seq-ordered onchain). */
  async setState(data: T): Promise<void> {
    await this.sock.write(
      "setState",
      [this.id, stringToHex(JSON.stringify(data))],
      0n,
      this.stateSeen ? undefined : this.sock.gas.setStateCreate,
    );
    this.stateSeen = true;
  }

  /** Read the shared state straight from contract storage — free. */
  async getState(): Promise<T | null> {
    const raw = (await this.sock.client.readContract({
      address: this.sock.contract,
      abi: ABI,
      functionName: "roomState",
      args: [this.id],
    })) as Hex;
    if (!raw || raw === "0x") return null;
    this.stateSeen = true;
    try {
      return JSON.parse(hexToString(raw)) as T;
    } catch {
      return null;
    }
  }

  onPresence(cb: PresenceCb<P>): () => void {
    this.presenceCbs.push(cb);
    this.ensureFeed();
    return () => void (this.presenceCbs = this.presenceCbs.filter((c) => c !== cb));
  }

  onMessage(name: string | MessageCb<M>, cb?: MessageCb<M>): () => void {
    const entry =
      typeof name === "string" ? { name, cb: cb! } : { name: undefined, cb: name };
    this.messageCbs.push(entry);
    this.ensureFeed();
    return () => void (this.messageCbs = this.messageCbs.filter((c) => c !== entry));
  }

  onStateChange(cb: StateCb<T>): () => void {
    this.stateCbs.push(cb);
    this.ensureFeed();
    return () => void (this.stateCbs = this.stateCbs.filter((c) => c !== cb));
  }

  leave(): void {
    this.started = false;
    this.detachStream?.();
    this.detachStream = null;
    this.stopPolling();
  }

  /** True while this room's events are arriving over the subscription rather
   *  than the poll. Useful for a status pip; nothing depends on it. */
  get live(): boolean {
    return this.detachStream !== null && this.timer === null;
  }

  /** After a log gap: pull current truth straight from contract storage
   *  and surface it through the normal state channel. */
  private async refreshState() {
    try {
      const [state, seq] = await Promise.all([
        this.getState(),
        this.sock.client.readContract({
          address: this.sock.contract,
          abi: ABI,
          functionName: "stateSeq",
          args: [this.id],
        }) as Promise<bigint>,
      ]);
      if (state !== null)
        for (const cb of this.stateCbs) cb({ player: "", seq: Number(seq), state });
    } catch {
      /* next gap or event will retry */
    }
  }

  /** Start the read path once, whichever one this client was built with.
   *
   *  When a subscription is available the room polls until the socket
   *  confirms the subscription, then stops. There is no standing safety poll
   *  behind a healthy socket: it would give back the load this transport
   *  exists to save, and the socket is probed for liveness instead. The two
   *  paths only overlap across a transition, which `seen` absorbs. */
  private ensureFeed() {
    if (this.started) return;
    this.started = true;
    const stream = this.sock.stream;
    if (!stream) {
      this.startPolling();
      return;
    }
    // Poll while the subscription is being established so the opening
    // moments of a room are never dark.
    this.startPolling();
    this.detachStream = stream.attach(
      this.id,
      (log) => this.handleLog(log, log.commitState),
      (live) => (live ? this.stopPolling() : this.startPolling()),
    );
  }

  private startPolling() {
    if (this.timer || !this.started) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  private stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One getLogs sweep per tick: everything this contract emitted for this
   *  room since the last seen block. `latest` on Monad is the PROPOSED
   *  block, so this reads state ~one block ahead of finality. */
  private async poll() {
    if (this.polling) return;
    if (Date.now() < this.backoffUntil) return;
    this.polling = true;
    try {
      const head = await this.sock.client.getBlockNumber({ cacheTime: 0 });
      let from = this.fromBlock ?? head;
      if (head < from) return;
      // The RPC caps eth_getLogs at a 100-block range, and a backgrounded
      // tab (throttled timers) can fall much further behind. Skip ahead in
      // one capped hop — and because that skips ground, re-read the shared
      // state from storage so puzzles never stay stale.
      if (head - from > 90n) {
        from = head - 90n;
        if (this.stateCbs.length) void this.refreshState();
      }
      this.fromBlock = from;
      // Filter at the node, not in the browser. `room` is topic 1 on all
      // three events, so the RPC can ship this room's traffic alone instead
      // of every room of every app sharing the contract — and that saving
      // grows as the contract does.
      //
      // This goes through eth_getLogs directly because viem's
      // getLogs({ events, args }) cannot express it: it ORs the signatures
      // into topic 0 but drops `args` at the RPC layer and re-applies them
      // client-side in parseEventLogs, so the same bytes still cross the
      // wire. Decoding below was already manual, so nothing is lost.
      const logs = (await this.sock.client.request({
        method: "eth_getLogs",
        params: [
          {
            address: this.sock.contract,
            topics: [ROOM_EVENT_TOPICS, this.id],
            fromBlock: numberToHex(from),
            toBlock: numberToHex(head),
          },
        ],
      })) as RpcLog[];
      this.fromBlock = head + 1n;
      for (const log of logs) this.handleLog(log);
      // One good sweep clears the debt — an outage should cost latency while
      // it lasts, not afterwards.
      this.failures = 0;
      this.backoffUntil = 0;
    } catch {
      // Transient RPC failure. fromBlock is unchanged, so nothing is missed;
      // the only question is how hard to push while the endpoint is unwell.
      this.failures++;
      const wait = Math.min(POLL_MS * 2 ** this.failures, BACKOFF_MAX_MS);
      this.backoffUntil = Date.now() + wait;
    } finally {
      this.polling = false;
    }
  }

  /** Decode one log and fan it out. The single place both read paths meet,
   *  so the subscription and the poll cannot drift apart in what they
   *  deliver — only in when. */
  private handleLog(log: RpcLog | StreamLog, commitState?: CommitState) {
    if (!log.transactionHash || log.logIndex == null) return;
    // Deduplicate AFTER any commit-state gate upstream, never before: marking
    // a Proposed copy as seen would swallow the Finalized one that a
    // certainty-minded subscriber is actually waiting for.
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) {
      // Sets iterate in insertion order, so this drops the oldest quarter.
      let drop = SEEN_MAX / 4;
      for (const k of this.seen) {
        this.seen.delete(k);
        if (--drop <= 0) break;
      }
    }

    // Keep the poll's watermark ahead of anything the socket delivered, so a
    // dropped connection resumes from where the stream got to rather than
    // replaying — or worse, skipping — the gap.
    const block = BigInt(log.blockNumber ?? 0);
    if (block > 0n && (this.fromBlock === null || block >= this.fromBlock))
      this.fromBlock = block + 1n;

    let decoded;
    try {
      decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
    } catch {
      return;
    }
    const args = decoded.args as Record<string, unknown>;
    // Belt and braces: the topic filter already pins the room, but a proxy or
    // RPC that quietly ignores topics must not leak another room's events
    // into this one's callbacks.
    if ((args.room as string)?.toLowerCase() !== this.id.toLowerCase()) return;
    const player = (args.player as string).toLowerCase();
    // Raw JSON-RPC hands these back as hex strings, not numbers.
    // 100k logs/block headroom keeps seq strictly monotonic across blocks
    const seq = Number(log.blockNumber ?? 0) * 100_000 + Number(log.logIndex ?? 0);
    const parse = <V,>(hex: Hex): V | null => {
      try {
        return JSON.parse(hexToString(hex)) as V;
      } catch {
        return null;
      }
    };
    // Each callback is isolated: one throwing subscriber must not eat the
    // rest of the batch (fromBlock has already advanced past it).
    const safely = (fn: () => void) => {
      try {
        fn();
      } catch {
        /* subscriber error — not the transport's problem */
      }
    };
    if (decoded.eventName === "Presence") {
      const data = parse<P>(args.data as Hex);
      if (data === null) return;
      const entry = { player, data, seq, at: Date.now(), commitState };
      for (const cb of this.presenceCbs) safely(() => cb(entry));
    } else if (decoded.eventName === "Message") {
      const data = parse<M>(args.data as Hex);
      if (data === null) return;
      const name = args.name as string;
      for (const { name: want, cb } of this.messageCbs)
        if (!want || want === name)
          safely(() => cb({ player, name, data, commitState }));
    } else if (decoded.eventName === "StateChange") {
      const state = parse<T>(args.data as Hex);
      if (state === null) return;
      this.stateSeen = true;
      for (const cb of this.stateCbs)
        safely(() =>
          cb({ player, seq: Number(args.seq as bigint), state, commitState }),
        );
    }
  }
}

/** Entity interpolation: buffers each player's last two presence samples and
 *  renders the roster at (now - delayMs), turning ~1-2Hz onchain broadcasts
 *  into smooth 60fps movement. */
export function smoothPresence<P extends Record<string, unknown>>(
  room: { onPresence(cb: (e: PresenceEntry<P>) => void): () => void },
  render: (players: ReadonlyMap<string, PresenceEntry<P>>) => void,
  opts: { hz?: number; delayMs?: number; staleMs?: number } = {},
): () => void {
  const hz = opts.hz ?? 60;
  const delayMs = opts.delayMs ?? 900; // one broadcast interval + block time
  const staleMs = opts.staleMs ?? 8_000;

  type Sample = { data: P; at: number };
  const buffers = new Map<string, { seq: number; a?: Sample; b: Sample }>();

  const unsub = room.onPresence(({ player, data, seq }) => {
    const buf = buffers.get(player);
    if (buf && seq <= buf.seq) return;
    const sample = { data, at: Date.now() };
    buffers.set(player, buf ? { seq, a: buf.b, b: sample } : { seq, b: sample });
  });

  const lerp = (a: P, b: P, t: number): P => {
    const out: Record<string, unknown> = { ...b };
    // Interpolate positions ONLY — lerping discrete fields (facing, carry)
    // produces fractional nonsense mid-flight.
    for (const k of ["x", "y"]) {
      const va = a[k];
      const vb = b[k];
      if (typeof va === "number" && typeof vb === "number") out[k] = va + (vb - va) * t;
    }
    return out as P;
  };

  const timer = setInterval(() => {
    const now = Date.now();
    const renderAt = now - delayMs;
    const view = new Map<string, PresenceEntry<P>>();
    for (const [key, buf] of buffers) {
      if (now - buf.b.at > staleMs) {
        buffers.delete(key);
        continue;
      }
      let data = buf.b.data;
      if (buf.a && buf.b.at > buf.a.at && renderAt < buf.b.at) {
        const t = Math.max(0, (renderAt - buf.a.at) / (buf.b.at - buf.a.at));
        data = lerp(buf.a.data, buf.b.data, Math.min(1, t));
      }
      view.set(key, { player: key, data, seq: buf.seq, at: buf.b.at });
    }
    render(view);
  }, 1000 / hz);

  return () => {
    unsub();
    clearInterval(timer);
  };
}
