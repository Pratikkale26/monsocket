/**
 * monsocket — Socket.io for Monad.
 *
 * The same rooms/broadcast/subscribe API as solsocket (its Solana sibling),
 * re-based on a Monad L1 transport:
 *  - writes: raw EIP-1559 transactions signed locally by a burner key with a
 *    LOCAL nonce counter and fixed gas limits (Monad bills gas_limit, not
 *    gas_used — padding is real money), fired without simulation.
 *  - reads: one getLogs poll per room per ~250ms against `latest`, which on
 *    Monad is PROPOSED state — speculative, one block ahead of finality.
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
  stringToHex,
  toBytes,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ABI } from "./contract.ts";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});

/** Fixed gas limits per action — tuned tight because Monad charges the
 *  limit. Presence/messages are log-only (~26k real); setState touches
 *  storage for a dynamic bytes value. */
const GAS = { broadcast: 30_000n, send: 36_000n, setState: 160_000n } as const;
const MAX_FEE = 150_000_000_000n; // 150 gwei (min base fee is 100)
const PRIORITY = 2_000_000_000n;
const POLL_MS = 250;

export interface PresenceEntry<P> {
  player: string;
  data: P;
  seq: number;
  at: number;
}
type PresenceCb<P> = (e: PresenceEntry<P>) => void;
type MessageCb<M> = (e: { player: string; name: string; data: M }) => void;
type StateCb<T> = (e: { player: string; seq: number; state: T }) => void;

export interface ConnectOpts {
  key: Hex; // burner private key — signs every action, no popups
  contract: Hex;
  rpc?: string;
}

export class MonSocket {
  readonly account: PrivateKeyAccount;
  readonly address: Hex;
  readonly client: PublicClient;
  readonly contract: Hex;
  private nonce: number | null = null;

  private constructor(opts: ConnectOpts) {
    this.account = privateKeyToAccount(opts.key);
    this.address = this.account.address;
    this.contract = opts.contract;
    this.client = createPublicClient({
      chain: monadTestnet,
      transport: http(opts.rpc ?? monadTestnet.rpcUrls.default.http[0]),
    });
  }

  static connect(opts: ConnectOpts): MonSocket {
    return new MonSocket(opts);
  }

  async balance(): Promise<bigint> {
    return this.client.getBalance({ address: this.address });
  }

  /** Sign + fire one contract call using the local nonce counter. Returns
   *  the tx hash without waiting for inclusion — realtime writes are
   *  fire-and-forget; the log stream is the acknowledgement. */
  async write(
    fn: "broadcast" | "send" | "setState",
    args: readonly unknown[],
  ): Promise<Hex> {
    if (this.nonce === null) {
      this.nonce = await this.client.getTransactionCount({
        address: this.address,
        blockTag: "latest",
      });
    }
    const nonce = this.nonce++;
    const serialized = await this.account.signTransaction({
      to: this.contract,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: encodeFunctionData({ abi: ABI, functionName: fn, args: args as any }),
      nonce,
      gas: GAS[fn],
      maxFeePerGas: MAX_FEE,
      maxPriorityFeePerGas: PRIORITY,
      chainId: monadTestnet.id,
      type: "eip1559",
    });
    try {
      return await this.client.sendRawTransaction({ serializedTransaction: serialized });
    } catch (err) {
      // Nonce drift (dropped tx, parallel tab) — resync once and surface.
      this.nonce = null;
      throw err;
    }
  }

  /** Same room name → same room id, on every client. */
  roomId(name: string): Hex {
    return keccak256(toBytes(name));
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
      void this.write("setState", [room.id, stringToHex(JSON.stringify(opts.initialState))]);
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
    await this.sock.write("setState", [this.id, stringToHex(JSON.stringify(data))]);
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
    try {
      return JSON.parse(hexToString(raw)) as T;
    } catch {
      return null;
    }
  }

  onPresence(cb: PresenceCb<P>): () => void {
    this.presenceCbs.push(cb);
    this.ensurePolling();
    return () => void (this.presenceCbs = this.presenceCbs.filter((c) => c !== cb));
  }

  onMessage(name: string | MessageCb<M>, cb?: MessageCb<M>): () => void {
    const entry =
      typeof name === "string" ? { name, cb: cb! } : { name: undefined, cb: name };
    this.messageCbs.push(entry);
    this.ensurePolling();
    return () => void (this.messageCbs = this.messageCbs.filter((c) => c !== entry));
  }

  onStateChange(cb: StateCb<T>): () => void {
    this.stateCbs.push(cb);
    this.ensurePolling();
    return () => void (this.stateCbs = this.stateCbs.filter((c) => c !== cb));
  }

  leave(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  private ensurePolling() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  /** One getLogs sweep per tick: everything this contract emitted for this
   *  room since the last seen block. `latest` on Monad is the PROPOSED
   *  block, so this reads state ~one block ahead of finality. */
  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const head = await this.sock.client.getBlockNumber({ cacheTime: 0 });
      if (this.fromBlock === null) this.fromBlock = head;
      if (head < this.fromBlock) return;
      // The RPC caps eth_getLogs at a 100-block range, and a backgrounded
      // tab (throttled timers) can fall much further behind. Skip ahead in
      // one capped hop — and because that skips ground, re-read the shared
      // state from storage so puzzles never stay stale.
      if (head - this.fromBlock > 90n) {
        this.fromBlock = head - 90n;
        if (this.stateCbs.length) void this.refreshState();
      }
      const logs = await this.sock.client.getLogs({
        address: this.sock.contract,
        fromBlock: this.fromBlock,
        toBlock: head,
      });
      this.fromBlock = head + 1n;
      for (const log of logs) {
        let decoded;
        try {
          decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
        } catch {
          continue;
        }
        const args = decoded.args as Record<string, unknown>;
        if ((args.room as string)?.toLowerCase() !== this.id.toLowerCase()) continue;
        const player = (args.player as string).toLowerCase();
        const seq = Number(log.blockNumber ?? 0n) * 1_000 + (log.logIndex ?? 0);
        const parse = <V,>(hex: Hex): V | null => {
          try {
            return JSON.parse(hexToString(hex)) as V;
          } catch {
            return null;
          }
        };
        if (decoded.eventName === "Presence") {
          const data = parse<P>(args.data as Hex);
          if (data === null) continue;
          const entry = { player, data, seq, at: Date.now() };
          for (const cb of this.presenceCbs) cb(entry);
        } else if (decoded.eventName === "Message") {
          const data = parse<M>(args.data as Hex);
          if (data === null) continue;
          const name = args.name as string;
          for (const { name: want, cb } of this.messageCbs)
            if (!want || want === name) cb({ player, name, data });
        } else if (decoded.eventName === "StateChange") {
          const state = parse<T>(args.data as Hex);
          if (state === null) continue;
          for (const cb of this.stateCbs)
            cb({ player, seq: Number(args.seq as bigint), state });
        }
      }
    } catch {
      /* transient RPC failure — next tick retries; fromBlock unchanged */
    } finally {
      this.polling = false;
    }
  }
}

/** Entity interpolation: buffers each player's last two presence samples and
 *  renders the roster at (now - delayMs), turning ~1-2Hz onchain broadcasts
 *  into smooth 60fps movement. Direct port of solsocket's smoothPresence. */
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
    for (const k of Object.keys(b)) {
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
