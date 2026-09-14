import { RULES } from "@/shared/rules";
import { World, defaultTiming, type Fly } from "@/shared/sim";
import { Bots } from "@/shared/bots";
import { buildState } from "@/shared/snapshot";
import { encodeState, type ClientMessage, type RosterEntry, type ServerMessage } from "@/shared/protocol";
import { cleanName, hueForIndex } from "@/shared/names";

/**
 * The pit, in the browser, when no arena answers: the same simulation,
 * the same bots, the same rules and clocks — on play money. It speaks the
 * arena's protocol through the WebSocket surface the client already uses
 * (readyState / send / onmessage / close), so nothing else in the client
 * knows it is talking to itself.
 *
 * What it is not: the money game. Nothing won or lost here exists, the
 * lobby refills itself, there is no wallet and no bank. A page served with
 * no arena reachable (a static host alone, say) lands here instead of on
 * "server offline", and the client keeps probing for a real arena.
 */

const PRACTICE_LOBBY = 10_000; // 100 tokens, refilled after every life

export class PracticeArena {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private readonly world = new World((Date.now() & 0xffff) || 1, defaultTiming(1));
  private readonly bots = new Bots(this.world, { count: 14, stake: () => RULES.botStakeCoins });
  private readonly known = new Map<number, number>();
  private readonly names = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private myId = 0;
  private lobby = PRACTICE_LOBBY;
  private hue = 0;
  private specX = 0;
  private specY = 0;
  private rainAcc = 0;
  private greeted = false;

  constructor() {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = this.OPEN;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== this.OPEN) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case "hello":
        if (!this.greeted) {
          this.greeted = true;
          this.hello();
        }
        break;
      case "spawn":
        this.spawn(msg.coins, msg.name);
        break;
      case "input":
        if (this.myId) this.world.setInput(this.myId, Number(msg.a), msg.b === 1);
        break;
      case "ping":
        this.emit({ t: "pong", n: msg.n, serverTime: this.world.time });
        break;
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }

  // ─────────────────────────────── the pit ──────────────────────────────

  private hello(): void {
    // A running start: the bots have already been at it for a while.
    for (let i = 0; i < 400; i++) this.tick(true);
    this.emit({
      t: "welcome",
      rules: RULES,
      timing: this.world.timing,
      hatches: this.world.hatches,
      exitTollBps: 0,
      live: false,
      liveNote: "No arena is reachable from this page, so this is a practice pit: same rules, bots, play money.",
      token: { symbol: "FLYPIT", decimals: 18, address: null },
      arena: null,
      chainId: 4663,
      devFaucet: false,
      you: this.you(),
      flyId: null,
    });
    this.emit({ t: "roster", full: true, add: this.roster() });
    this.timer = setInterval(() => this.tick(false), 1000 / RULES.tickHz);
  }

  private spawn(coinsRaw: unknown, nameRaw: unknown): void {
    if (this.myId && this.world.flies.get(this.myId)?.alive) return this.emit({ t: "error", message: "You are already in the pit." });
    const coins = Math.floor(Number(coinsRaw));
    if (!Number.isFinite(coins) || coins < RULES.minStakeCoins || coins > RULES.maxStakeCoins) {
      return this.emit({ t: "error", message: `A stake is between ${RULES.minStakeCoins / RULES.coinsPerToken} and ${RULES.maxStakeCoins / RULES.coinsPerToken} FLYPIT.` });
    }
    if (coins > this.lobby) return this.emit({ t: "error", message: "Not that much in the practice lobby." });
    const name = cleanName(nameRaw) ?? "You";
    this.hue = hueForIndex(Math.floor(Math.random() * 12));
    const fly = this.world.spawn({ owner: "practice", name, hue: this.hue, bot: false, coins });
    this.myId = fly.id;
    this.lobby -= coins;
    this.known.clear();
    this.names.set(fly.id, name);
    this.emit({ t: "roster", add: [{ id: fly.id, name, hue: fly.hue, bot: false }] });
    this.emit({ t: "spawned", id: fly.id });
    this.emit({ t: "you", you: this.you() });
  }

  private tick(silent: boolean): void {
    const dt = 1 / RULES.tickHz;
    this.bots.maintain();
    this.bots.think();
    const events = this.world.step(dt);

    // Play money rains at the server's default rate, from nowhere.
    this.rainAcc += dt;
    if (this.rainAcc >= 2) {
      this.rainAcc = 0;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * RULES.arenaRadius * 0.92;
      this.world.dropPellet(Math.cos(a) * r, Math.sin(a) * r, RULES.rainPelletCoins);
    }

    const named = events.map((e) => ({
      e,
      name: "id" in e ? (this.nameOf(e.id) ?? "?") : "?",
      killerName: e.type === "death" && e.killerId !== null ? this.nameOf(e.killerId) : null,
    }));
    for (const { e, name, killerName } of named) {
      if (e.type === "death") {
        if (this.bots.has(e.id)) this.bots.onDeath(e.id);
        const mine = e.id === this.myId;
        if (mine) {
          this.myId = 0;
          this.lobby = Math.max(this.lobby, PRACTICE_LOBBY);
        }
        this.names.delete(e.id);
        if (silent) continue;
        this.emit({ t: "roster", remove: [e.id] });
        this.emit({ t: "death", id: e.id, name, killerId: e.killerId, killerName, cause: e.cause, coins: e.coins, x: e.x, y: e.y, mine });
        if (mine) this.emit({ t: "you", you: this.you() });
      } else if (e.type === "extracted") {
        const mine = e.id === this.myId;
        if (mine) {
          this.myId = 0;
          this.lobby += e.coins;
        }
        this.names.delete(e.id);
        if (silent) continue;
        this.emit({ t: "roster", remove: [e.id] });
        this.emit({ t: "extracted", id: e.id, name, coins: e.coins, net: e.coins, toll: 0, x: e.x, y: e.y, mine });
        if (mine) this.emit({ t: "you", you: this.you() });
      }
    }
    if (silent) return;

    // Camera: my fly, else the biggest one.
    const me = this.myId ? this.world.flies.get(this.myId) : undefined;
    let camX: number;
    let camY: number;
    if (me && me.alive) {
      camX = me.x;
      camY = me.y;
    } else {
      let best: Fly | null = null;
      for (const f of this.world.flies.values()) if (f.alive && (!best || f.coins > best.coins)) best = f;
      this.specX += ((best ? best.x : 0) - this.specX) * 0.12;
      this.specY += ((best ? best.y : 0) - this.specY) * 0.12;
      camX = this.specX;
      camY = this.specY;
    }
    const state = buildState(this.world, { camX, camY, myId: me && me.alive ? me.id : 0, known: this.known });
    this.onmessage?.(new MessageEvent("message", { data: encodeState(state) }));

    if (this.world.tick % RULES.tickHz === 0) {
      const alive = this.world.aliveFlies();
      for (const f of alive) if (!this.names.has(f.id)) this.emit({ t: "roster", add: [this.entry(f)] });
      this.emit({
        t: "board",
        top: alive
          .slice()
          .sort((a, b) => b.coins - a.coins)
          .slice(0, 10)
          .map((f) => ({ id: f.id, name: f.name, coins: f.coins, kills: f.kills })),
        alive: alive.length,
        players: 1,
        floor: this.world.floorCoins(),
        pot: 0,
      });
    }
  }

  // ─────────────────────────────── helpers ──────────────────────────────

  private you() {
    return {
      address: "practice",
      name: "You",
      lobbyCoins: this.lobby,
      lobbyWei: (BigInt(this.lobby) * 10n ** 16n).toString(),
      claimableWei: "0",
      claimedWei: "0",
    };
  }

  private nameOf(id: number): string | null {
    return this.names.get(id) ?? this.world.flies.get(id)?.name ?? null;
  }

  private entry(f: Fly): RosterEntry {
    this.names.set(f.id, f.name);
    return { id: f.id, name: f.name, hue: f.hue, bot: f.bot };
  }

  private roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const f of this.world.flies.values()) if (f.alive) out.push(this.entry(f));
    return out;
  }

  private emit(msg: ServerMessage): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
}
