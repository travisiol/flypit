import type { WebSocket } from "ws";
import { RULES, radiusFor } from "../../web/src/shared/rules";
import { World, defaultTiming, type Fly, type SimEvent } from "../../web/src/shared/sim";
import {
  FLAG_BOOST,
  FLAG_BOT,
  FLAG_HATCHES_OPEN,
  FLAG_IN_HATCH,
  FLAG_ORPHAN,
  FLAG_SHIELD,
  encodeState,
  type BoardRow,
  type FlyWire,
  type RosterEntry,
  type ServerMessage,
  type StateWire,
  type YouState,
} from "../../web/src/shared/protocol";
import { cleanName, hueForIndex, shortAddress } from "../../web/src/shared/names";
import { chainConfigured, config, liveNote } from "./config";
import * as db from "./db";
import { Bots } from "./bots";

/**
 * The arena server: one World stepped twenty times a second, every socket
 * that watches or plays it, and the seam between the simulation's whole
 * coins and the ledger's wei. This is the referee. Nothing a client sends
 * is trusted beyond "which way" and "boost or not".
 */

export interface Client {
  ws: WebSocket;
  ip: string;
  /** Signed-in wallet, lowercase, or null for a spectator. */
  address: string | null;
  flyId: number | null;
  /** Fly ids this client holds a synced path for → tick of the last full path. */
  known: Map<number, number>;
  camX: number;
  camY: number;
  inputs: number;
  inputWindow: number;
}

const VIEW_HALF_W = 1400;
const VIEW_HALF_H = 950;
const PATH_RESYNC_TICKS = 20;
const INPUTS_PER_SECOND = 40;

export class Arena {
  readonly world: World;
  readonly bots: Bots;
  readonly clients = new Set<Client>();
  /** address → fly id, one fly per wallet. */
  private readonly owners = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private rainAcc = 0;
  private lastCheckpointAt = 0;
  private hueCounter = 0;
  private specX = 0;
  private specY = 0;
  private stopped = false;

  constructor() {
    this.world = new World(Date.now() & 0xffff, defaultTiming(config.timeScale));
    this.bots = new Bots(this.world);
  }

  // ─────────────────────────────── loop ────────────────────────────────

  start(): void {
    const dt = 1 / RULES.tickHz;
    this.timer = setInterval(() => {
      try {
        this.tickOnce(dt);
      } catch (err) {
        console.error("[arena] tick failed", err);
      }
    }, 1000 / RULES.tickHz);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  private tickOnce(dt: number): void {
    this.bots.maintain();
    this.bots.think();
    const events = this.world.step(dt);
    this.handleEvents(events);
    this.rain(dt);
    this.updateSpectatorCamera();
    for (const c of this.clients) this.sendState(c);
    if (this.world.tick % RULES.tickHz === 0) this.broadcastBoard();
    if (this.world.time - this.lastCheckpointAt >= config.checkpointSeconds) {
      this.lastCheckpointAt = this.world.time;
      this.checkpoint();
    }
  }

  private handleEvents(events: SimEvent[]): void {
    // Resolve every name first: two flies that die together each name the other.
    const named = events.map((e) => ({
      e,
      name: "id" in e ? (this.nameOf(e.id) ?? "?") : "?",
      killerName: e.type === "death" && e.killerId !== null ? this.nameOf(e.killerId) : null,
    }));
    for (const { e, name, killerName } of named) {
      if (e.type === "death") {
        if (this.bots.has(e.id)) {
          this.bots.onDeath(e.id);
        } else {
          this.owners.delete(e.owner);
          db.recordHistory("death", e.owner, name, e.coins, e.cause + (killerName ? `:${killerName}` : ""));
        }
        this.names.delete(e.id);
        this.broadcast({ t: "roster", remove: [e.id] });
        for (const c of this.clients) {
          const mine = c.flyId === e.id;
          if (mine) c.flyId = null;
          this.send(c, {
            t: "death",
            id: e.id,
            name,
            killerId: e.killerId,
            killerName,
            cause: e.cause,
            coins: e.coins,
            x: e.x,
            y: e.y,
            mine,
          });
        }
      } else if (e.type === "extracted") {
        this.owners.delete(e.owner);
        const { net, toll } = db.extract(e.owner, e.coins);
        db.recordHistory("extract", e.owner, name, e.coins, `net:${net} toll:${toll}`);
        this.names.delete(e.id);
        this.broadcast({ t: "roster", remove: [e.id] });
        for (const c of this.clients) {
          const mine = c.flyId === e.id;
          if (mine) c.flyId = null;
          this.send(c, { t: "extracted", id: e.id, name, coins: e.coins, net, toll, x: e.x, y: e.y, mine });
          if (mine) this.sendYou(c);
        }
      }
    }
  }

  /** The pot rains pellets at `rainPerMinute`, one at a time, only while it can pay. */
  private rain(dt: number): void {
    if (config.rainPerMinute <= 0) return;
    this.rainAcc += dt;
    const interval = 60 / config.rainPerMinute;
    while (this.rainAcc >= interval) {
      this.rainAcc -= interval;
      if (!db.drawPot(RULES.rainPelletCoins)) {
        this.rainAcc = 0;
        return;
      }
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * RULES.arenaRadius * 0.92;
      this.world.dropPellet(Math.cos(a) * r, Math.sin(a) * r, RULES.rainPelletCoins);
    }
  }

  private updateSpectatorCamera(): void {
    let best: Fly | null = null;
    for (const f of this.world.flies.values()) {
      if (!f.alive) continue;
      if (!best || f.coins > best.coins) best = f;
    }
    const tx = best ? best.x : 0;
    const ty = best ? best.y : 0;
    this.specX += (tx - this.specX) * 0.12;
    this.specY += (ty - this.specY) * 0.12;
  }

  /** Writes the crash shadow and checks the books. */
  private checkpoint(): void {
    const rows: { owner: string; coins: number }[] = [];
    let floorAndBots = this.world.floorCoins();
    for (const f of this.world.flies.values()) {
      if (!f.alive) continue;
      if (f.bot) floorAndBots += f.coins;
      else rows.push({ owner: f.owner, coins: f.coins });
    }
    db.writeCheckpoint(rows, floorAndBots);
    const b = db.books(this.world.totalCoins());
    if (b.drift !== 0n) console.error(`[books] DRIFT ${b.drift.toString()} wei — the ledger and the arena disagree`);
  }

  // ─────────────────────────────── clients ──────────────────────────────

  connect(ws: WebSocket, ip: string): Client {
    const client: Client = {
      ws,
      ip,
      address: null,
      flyId: null,
      known: new Map(),
      camX: 0,
      camY: 0,
      inputs: 0,
      inputWindow: 0,
    };
    this.clients.add(client);
    return client;
  }

  disconnect(client: Client): void {
    this.clients.delete(client);
    if (client.flyId !== null) {
      const fly = this.world.flies.get(client.flyId);
      // Another socket of the same wallet may already hold the fly.
      const held = [...this.clients].some((c) => c !== client && c.flyId === client.flyId);
      if (fly && fly.alive && !held) fly.orphanedAt = this.world.time;
    }
  }

  /** A signed-in socket: reattach to a fly this wallet still has in the pit, if any. */
  hello(client: Client, address: string | null): void {
    client.address = address;
    client.flyId = null;
    if (address) {
      const flyId = this.owners.get(address);
      if (flyId !== undefined) {
        const fly = this.world.flies.get(flyId);
        if (fly && fly.alive) {
          fly.orphanedAt = null;
          client.flyId = flyId;
          // Only one socket drives a fly: older ones become spectators.
          for (const other of this.clients) if (other !== client && other.flyId === flyId) other.flyId = null;
        }
      }
    }
    this.send(client, {
      t: "welcome",
      rules: RULES,
      timing: this.world.timing,
      hatches: this.world.hatches,
      exitTollBps: config.exitTollBps,
      live: chainConfigured(),
      liveNote: liveNote(),
      token: { symbol: config.tokenSymbol, decimals: config.tokenDecimals, address: config.tokenAddress || null },
      arena: config.arenaAddress || null,
      chainId: config.chainId,
      devFaucet: config.devFaucet,
      you: address ? this.youState(address) : null,
      flyId: client.flyId,
    });
    this.send(client, { t: "roster", full: true, add: this.rosterEntries() });
  }

  spawnRequest(client: Client, coinsRaw: unknown, nameRaw: unknown): void {
    if (!client.address) return this.error(client, "Connect a wallet to enter the pit.");
    if (client.flyId !== null && this.world.flies.get(client.flyId)?.alive) return this.error(client, "You are already in the pit.");
    if (this.owners.has(client.address)) return this.error(client, "This wallet already has a fly in the pit.");
    const coins = Math.floor(Number(coinsRaw));
    if (!Number.isFinite(coins) || coins < RULES.minStakeCoins || coins > RULES.maxStakeCoins) {
      return this.error(client, `A stake is between ${RULES.minStakeCoins / RULES.coinsPerToken} and ${RULES.maxStakeCoins / RULES.coinsPerToken} ${config.tokenSymbol}.`);
    }
    const chosen = cleanName(nameRaw);
    if (nameRaw !== undefined && nameRaw !== "" && !chosen) {
      return this.error(client, "Names are 2–14 letters or digits, and bot names are taken.");
    }
    if (chosen) db.setName(client.address, chosen);
    const account = db.getAccount(client.address);
    const name = chosen ?? account?.name ?? shortAddress(client.address);

    if (!db.stake(client.address, coins)) {
      const have = account ? db.weiToCoins(account.lobby_wei) : 0;
      return this.error(client, `Your lobby holds ${(have / RULES.coinsPerToken).toFixed(2)} ${config.tokenSymbol}; deposit more to stake that.`);
    }
    this.hueCounter += 1;
    const fly = this.world.spawn({ owner: client.address, name, hue: hueForIndex(this.hueCounter), bot: false, coins });
    this.owners.set(client.address, fly.id);
    client.flyId = fly.id;
    client.known.clear();
    db.recordHistory("spawn", client.address, name, coins);
    this.broadcast({ t: "roster", add: [this.rosterEntry(fly)] });
    this.send(client, { t: "spawned", id: fly.id });
    this.sendYou(client);
  }

  input(client: Client, angle: unknown, boost: unknown): void {
    if (client.flyId === null) return;
    // 40 inputs a second is plenty for a pointer; more is a script.
    const now = this.world.tick;
    if (now !== client.inputWindow) {
      client.inputWindow = now;
      client.inputs = 0;
    }
    if (++client.inputs > Math.ceil(INPUTS_PER_SECOND / RULES.tickHz) + 1) return;
    const a = Number(angle);
    if (!Number.isFinite(a)) return;
    this.world.setInput(client.flyId, a, boost === 1 || boost === true);
  }

  /** Pushes fresh lobby numbers to every socket of this wallet (after a deposit lands, say). */
  refreshYou(address: string): void {
    for (const c of this.clients) if (c.address === address) this.sendYou(c);
  }

  // ─────────────────────────────── snapshots ────────────────────────────

  private sendState(client: Client): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    const me = client.flyId !== null ? this.world.flies.get(client.flyId) : undefined;
    if (me && me.alive) {
      client.camX = me.x;
      client.camY = me.y;
    } else {
      client.camX = this.specX;
      client.camY = this.specY;
    }
    const x0 = client.camX - VIEW_HALF_W;
    const x1 = client.camX + VIEW_HALF_W;
    const y0 = client.camY - VIEW_HALF_H;
    const y1 = client.camY + VIEW_HALF_H;

    const flies: FlyWire[] = [];
    const seen = new Set<number>();
    for (const f of this.world.flies.values()) {
      if (!f.alive) continue;
      if (!this.touchesBox(f, x0, y0, x1, y1)) continue;
      seen.add(f.id);
      const last = client.known.get(f.id);
      const resync = last === undefined || this.world.tick - last >= PATH_RESYNC_TICKS;
      if (resync) client.known.set(f.id, this.world.tick);
      let flags = 0;
      if (f.boosting) flags |= FLAG_BOOST;
      if (this.world.time < f.shieldUntil) flags |= FLAG_SHIELD;
      if (f.hatch >= 0) flags |= FLAG_IN_HATCH;
      if (f.bot) flags |= FLAG_BOT;
      if (this.world.hatchesOpenFor(f)) flags |= FLAG_HATCHES_OPEN;
      if (f.orphanedAt !== null) flags |= FLAG_ORPHAN;
      flies.push({
        id: f.id,
        x: f.x,
        y: f.y,
        angle: f.angle,
        coins: f.coins,
        flags,
        extract: f.extract / this.world.timing.extractSeconds,
        segments: f.segments,
        path: resync ? f.path.slice(0, f.segments + 2) : null,
      });
    }
    for (const id of client.known.keys()) if (!seen.has(id)) client.known.delete(id);

    const pellets = this.world.pelletsInRect(x0, y0, x1, y1).map((p) => ({ id: p.id, x: p.x, y: p.y, value: p.value }));
    const state: StateWire = {
      tick: this.world.tick,
      time: this.world.time,
      camX: client.camX,
      camY: client.camY,
      myId: me && me.alive ? me.id : 0,
      flies,
      pellets,
    };
    client.ws.send(encodeState(state), { binary: true });
  }

  private touchesBox(f: Fly, x0: number, y0: number, x1: number, y1: number): boolean {
    const pad = radiusFor(f.coins) + 40;
    if (f.x >= x0 - pad && f.x <= x1 + pad && f.y >= y0 - pad && f.y <= y1 + pad) return true;
    const n = Math.min(f.segments + 1, f.path.length);
    for (let i = 0; i < n; i += 6) {
      const p = f.path[i];
      if (p.x >= x0 - pad && p.x <= x1 + pad && p.y >= y0 - pad && p.y <= y1 + pad) return true;
    }
    return false;
  }

  // ─────────────────────────────── roster ───────────────────────────────

  private readonly names = new Map<number, string>();

  private nameOf(id: number): string | null {
    return this.names.get(id) ?? this.world.flies.get(id)?.name ?? null;
  }

  private rosterEntry(f: Fly): RosterEntry {
    this.names.set(f.id, f.name);
    return { id: f.id, name: f.name, hue: f.hue, bot: f.bot };
  }

  private rosterEntries(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const f of this.world.flies.values()) if (f.alive) out.push(this.rosterEntry(f));
    return out;
  }

  private broadcastBoard(): void {
    const alive = this.world.aliveFlies();
    const top: BoardRow[] = alive
      .slice()
      .sort((a, b) => b.coins - a.coins)
      .slice(0, 10)
      .map((f) => ({ id: f.id, name: f.name, coins: f.coins, kills: f.kills }));
    // New bots appear through the board before any roster add; make sure names exist.
    for (const f of alive) if (!this.names.has(f.id)) this.broadcast({ t: "roster", add: [this.rosterEntry(f)] });
    let players = 0;
    for (const c of this.clients) if (c.address) players++;
    this.broadcast({
      t: "board",
      top,
      alive: alive.length,
      players,
      floor: this.world.floorCoins(),
      pot: db.weiToCoins(db.potWei()),
    });
  }

  // ─────────────────────────────── helpers ──────────────────────────────

  youState(address: string): YouState {
    const a = db.ensureAccount(address);
    return {
      address,
      name: a.name,
      lobbyCoins: db.weiToCoins(a.lobby_wei),
      lobbyWei: a.lobby_wei.toString(),
      claimableWei: a.claimable_wei.toString(),
      claimedWei: a.claimed_wei.toString(),
    };
  }

  private sendYou(client: Client): void {
    if (!client.address) return;
    this.send(client, { t: "you", you: this.youState(client.address) });
  }

  private error(client: Client, message: string): void {
    this.send(client, { t: "error", message });
  }

  send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  /** Public counters for /status. */
  stats(): { alive: number; bots: number; players: number; sockets: number; floor: number; pot: number; arenaCoins: number } {
    let players = 0;
    for (const c of this.clients) if (c.address) players++;
    return {
      alive: this.world.aliveFlies().length,
      bots: this.bots.count(),
      players,
      sockets: this.clients.size,
      floor: this.world.floorCoins(),
      pot: db.weiToCoins(db.potWei()),
      arenaCoins: this.world.totalCoins(),
    };
  }

  /**
   * Graceful stop: players' coins go back to their lobby untouched, the
   * floor and the bots' coins go back to the pot. Nothing is lost and no
   * toll is taken — a restart is not an extraction.
   */
  drain(): { players: number; coins: number; floor: number } {
    this.stop();
    let players = 0;
    let coins = 0;
    let floor = this.world.floorCoins();
    for (const f of [...this.world.flies.values()]) {
      if (!f.alive) continue;
      const c = this.world.remove(f.id);
      if (f.bot) floor += c;
      else {
        db.refund(f.owner, c);
        players++;
        coins += c;
      }
    }
    for (const p of [...this.world.pellets.keys()]) this.world.pellets.delete(p);
    db.returnToPot(floor);
    db.writeCheckpoint([], 0);
    return { players, coins, floor };
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
