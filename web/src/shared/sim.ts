/**
 * The arena, as pure arithmetic. No sockets, no clock, no chain: the server
 * feeds it inputs and calls `step(dt)`, the headless test does the same,
 * and the client mirrors the parts it needs to draw. Every coin that enters
 * through `spawn` or `dropPellet` is either inside a fly, lying on the floor
 * as a pellet, or has left through an `extracted` event. `totalCoins()` is
 * the invariant the tests hold the world to after every step.
 */
import {
  RULES,
  bodyRadiusFor,
  hatchPositions,
  radiusFor,
  segmentsFor,
  turnRateFor,
  type Hatch,
} from "./rules";
import { advancePath, dist, makeRng, turnToward, type Vec } from "./geometry";

export type DeathCause = "cut" | "headon" | "wall" | "timeout";

export interface Fly {
  id: number;
  /** Wallet address (lowercase) for players, `bot:<n>` for bots. */
  owner: string;
  name: string;
  hue: number;
  bot: boolean;
  x: number;
  y: number;
  /** Heading in radians. */
  angle: number;
  targetAngle: number;
  wantBoost: boolean;
  /** Boost actually applied this tick (coins, hatch and orphan rules can veto it). */
  boosting: boolean;
  coins: number;
  segments: number;
  /** Sampled trail, newest first. See `advancePath`. */
  path: Vec[];
  spawnedAt: number;
  shieldUntil: number;
  shedAcc: number;
  /** Index of the hatch the head is inside, or -1. */
  hatch: number;
  /** Seconds accumulated inside a hatch toward extraction. */
  extract: number;
  /** World time the owner's socket dropped, or null while connected. */
  orphanedAt: number | null;
  kills: number;
  alive: boolean;
}

export interface Pellet {
  id: number;
  x: number;
  y: number;
  value: number;
}

export type SimEvent =
  | {
      type: "death";
      id: number;
      owner: string;
      killerId: number | null;
      cause: DeathCause;
      coins: number;
      x: number;
      y: number;
    }
  | { type: "extracted"; id: number; owner: string; coins: number; x: number; y: number }
  | { type: "pickup"; id: number; pelletId: number; value: number }
  | { type: "shed"; id: number; pelletId: number; value: number }
  | { type: "kill"; id: number; victimId: number };

/**
 * The clocks the arena runs on. They default to the published rules; a
 * local server may shorten them (TIME_SCALE) so a test does not wait a
 * minute for a hatch to open. Movement is never scaled — only waiting.
 */
export interface Timing {
  spawnShieldSeconds: number;
  minStaySeconds: number;
  extractSeconds: number;
  disconnectGraceSeconds: number;
}

export function defaultTiming(scale = 1): Timing {
  return {
    spawnShieldSeconds: RULES.spawnShieldSeconds * scale,
    minStaySeconds: RULES.minStaySeconds * scale,
    extractSeconds: RULES.extractSeconds * scale,
    disconnectGraceSeconds: RULES.disconnectGraceSeconds * scale,
  };
}

export interface SpawnOptions {
  owner: string;
  name: string;
  hue: number;
  bot: boolean;
  coins: number;
  /** Optional fixed position (tests). */
  at?: { x: number; y: number; angle: number };
}

export function pelletRadius(value: number): number {
  return 3 + 1.1 * Math.log(1 + Math.max(0, value));
}

const PELLET_CELL = 64;
const BODY_CELL = 128;

function cellKey(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768);
}

interface BodyPoint {
  fly: Fly;
  x: number;
  y: number;
}

export class World {
  time = 0;
  tick = 0;
  readonly hatches: Hatch[] = hatchPositions();
  readonly flies = new Map<number, Fly>();
  readonly pellets = new Map<number, Pellet>();
  private nextFlyId = 1;
  private nextPelletId = 1;
  private readonly pelletGrid = new Map<number, Set<number>>();
  private readonly rng: () => number;
  readonly timing: Timing;

  constructor(seed = 1, timing: Timing = defaultTiming()) {
    this.rng = makeRng(seed);
    this.timing = timing;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  spawn(opts: SpawnOptions): Fly {
    const coins = Math.max(0, Math.floor(opts.coins));
    const at = opts.at ?? this.findSpawnPoint();
    const fly: Fly = {
      id: this.nextFlyId++,
      owner: opts.owner,
      name: opts.name,
      hue: opts.hue,
      bot: opts.bot,
      x: at.x,
      y: at.y,
      angle: at.angle,
      targetAngle: at.angle,
      wantBoost: false,
      boosting: false,
      coins,
      segments: segmentsFor(coins),
      path: [{ x: at.x, y: at.y }],
      spawnedAt: this.time,
      shieldUntil: this.time + this.timing.spawnShieldSeconds,
      shedAcc: 0,
      hatch: -1,
      extract: 0,
      orphanedAt: null,
      kills: 0,
      alive: true,
    };
    this.flies.set(fly.id, fly);
    return fly;
  }

  /** Takes a fly out without dropping anything. Returns its coins for the ledger. */
  remove(id: number): number {
    const fly = this.flies.get(id);
    if (!fly) return 0;
    fly.alive = false;
    this.flies.delete(id);
    return fly.coins;
  }

  setInput(id: number, angle: number, boost: boolean): void {
    const fly = this.flies.get(id);
    if (!fly || !fly.alive) return;
    if (Number.isFinite(angle)) fly.targetAngle = angle;
    fly.wantBoost = boost;
  }

  /** Puts `value` coins on the floor. Merges into a pellet lying right there. */
  dropPellet(x: number, y: number, value: number): Pellet {
    const v = Math.floor(value);
    if (v <= 0) throw new Error("dropPellet: value must be a positive whole number");
    const near = this.pelletsNear(x, y, 6);
    if (near.length > 0) {
      near[0].value += v;
      return near[0];
    }
    const pellet: Pellet = { id: this.nextPelletId++, x, y, value: v };
    this.pellets.set(pellet.id, pellet);
    this.gridAdd(pellet);
    if (this.pellets.size > RULES.maxPellets) this.compactPellets();
    return pellet;
  }

  /** Every coin the arena holds right now: in flies plus on the floor. */
  totalCoins(): number {
    let sum = 0;
    for (const f of this.flies.values()) sum += f.coins;
    for (const p of this.pellets.values()) sum += p.value;
    return sum;
  }

  floorCoins(): number {
    let sum = 0;
    for (const p of this.pellets.values()) sum += p.value;
    return sum;
  }

  aliveFlies(): Fly[] {
    return [...this.flies.values()].filter((f) => f.alive);
  }

  inHatch(fly: Fly): number {
    const r = radiusFor(fly.coins);
    for (const h of this.hatches) {
      if (dist(fly.x, fly.y, h.x, h.y) + r * 0.5 <= h.r) return h.id;
    }
    return -1;
  }

  /** True once a fly has been alive long enough for the hatches to take it. */
  hatchesOpenFor(fly: Fly): boolean {
    return !fly.bot && this.time - fly.spawnedAt >= this.timing.minStaySeconds;
  }

  findSpawnPoint(): { x: number; y: number; angle: number } {
    let best = { x: 0, y: 0, angle: 0 };
    let bestClear = -1;
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const rr = Math.sqrt(this.rng()) * RULES.arenaRadius * 0.78;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      let clear = Infinity;
      for (const f of this.flies.values()) {
        if (!f.alive) continue;
        clear = Math.min(clear, dist(x, y, f.x, f.y));
        for (let i = 0; i < f.path.length; i += 4) {
          clear = Math.min(clear, dist(x, y, f.path[i].x, f.path[i].y));
        }
      }
      for (const h of this.hatches) clear = Math.min(clear, dist(x, y, h.x, h.y) - h.r);
      if (clear > bestClear) {
        bestClear = clear;
        best = { x, y, angle: this.rng() * Math.PI * 2 - Math.PI };
      }
      if (clear > 600) break;
    }
    return best;
  }

  // ─────────────────────────────── step ────────────────────────────────

  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [];
    this.time += dt;
    this.tick += 1;

    // 1. Everyone moves.
    for (const fly of this.flies.values()) {
      if (!fly.alive) continue;
      this.move(fly, dt, events);
    }

    // 2. Collisions are decided on the positions everyone ended the tick at,
    //    then applied together, so two flies cutting each other both die.
    const deaths = this.findDeaths();
    for (const d of deaths) {
      const fly = this.flies.get(d.id);
      if (!fly || !fly.alive) continue;
      this.kill(fly, d.cause, d.killerId, events);
    }

    // 3. Pickups, hatches, orphans.
    for (const fly of this.flies.values()) {
      if (!fly.alive) continue;
      if (this.time >= fly.shieldUntil) this.pickup(fly, events);
      this.extraction(fly, dt, events);
      if (fly.orphanedAt !== null && this.time - fly.orphanedAt >= this.timing.disconnectGraceSeconds) {
        this.kill(fly, "timeout", null, events);
      }
    }

    return events;
  }

  private move(fly: Fly, dt: number, events: SimEvent[]): void {
    fly.segments = segmentsFor(fly.coins);
    const turn = turnRateFor(fly.segments) * dt;
    fly.angle = turnToward(fly.angle, fly.targetAngle, turn);

    fly.hatch = this.inHatch(fly);
    fly.boosting =
      fly.wantBoost && fly.orphanedAt === null && fly.hatch < 0 && fly.coins >= RULES.boostMinCoins;
    const speed = fly.boosting ? RULES.boostSpeed : RULES.baseSpeed;

    fly.x += Math.cos(fly.angle) * speed * dt;
    fly.y += Math.sin(fly.angle) * speed * dt;
    advancePath(fly.path, fly.x, fly.y, RULES.segmentSpacing, fly.segments + 4);

    if (fly.boosting) {
      fly.shedAcc += dt;
      while (fly.shedAcc >= RULES.boostShedInterval) {
        fly.shedAcc -= RULES.boostShedInterval;
        const shed = Math.max(1, Math.floor(fly.coins * RULES.boostShedRate));
        if (fly.coins - shed < RULES.boostMinCoins) {
          fly.boosting = false;
          break;
        }
        fly.coins -= shed;
        const tail = fly.path[Math.min(fly.path.length - 1, fly.segments)] ?? fly.path[fly.path.length - 1];
        const jx = (this.rng() - 0.5) * 8;
        const jy = (this.rng() - 0.5) * 8;
        const pellet = this.dropPellet(tail.x + jx, tail.y + jy, shed);
        events.push({ type: "shed", id: fly.id, pelletId: pellet.id, value: shed });
      }
    } else {
      fly.shedAcc = 0;
    }
  }

  private findDeaths(): { id: number; cause: DeathCause; killerId: number | null }[] {
    const out: { id: number; cause: DeathCause; killerId: number | null }[] = [];
    const alive: Fly[] = [];
    for (const f of this.flies.values()) if (f.alive) alive.push(f);

    // Body points of every unshielded fly, hashed by cell.
    const grid = new Map<number, BodyPoint[]>();
    for (const f of alive) {
      if (this.time < f.shieldUntil) continue;
      const n = Math.min(f.segments + 1, f.path.length);
      for (let i = 0; i < n; i++) {
        const p = f.path[i];
        const key = cellKey(Math.floor(p.x / BODY_CELL), Math.floor(p.y / BODY_CELL));
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push({ fly: f, x: p.x, y: p.y });
      }
    }

    for (const a of alive) {
      if (this.time < a.shieldUntil) continue;
      const ra = radiusFor(a.coins);

      if (Math.hypot(a.x, a.y) + ra > RULES.arenaRadius) {
        out.push({ id: a.id, cause: "wall", killerId: null });
        continue;
      }

      let dead = false;
      // Head on head first: symmetric, both die.
      for (const b of alive) {
        if (b === a || this.time < b.shieldUntil) continue;
        const rb = radiusFor(b.coins);
        if (dist(a.x, a.y, b.x, b.y) < ra + rb) {
          out.push({ id: a.id, cause: "headon", killerId: b.id });
          dead = true;
          break;
        }
      }
      if (dead) continue;

      const cx = Math.floor(a.x / BODY_CELL);
      const cy = Math.floor(a.y / BODY_CELL);
      const reach = ra * 0.85;
      search: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(cellKey(cx + dx, cy + dy));
          if (!bucket) continue;
          for (const bp of bucket) {
            if (bp.fly === a) continue;
            const rb = bodyRadiusFor(bp.fly.coins);
            if (dist(a.x, a.y, bp.x, bp.y) < reach + rb) {
              out.push({ id: a.id, cause: "cut", killerId: bp.fly.id });
              break search;
            }
          }
        }
      }
    }
    return out;
  }

  private kill(fly: Fly, cause: DeathCause, killerId: number | null, events: SimEvent[]): void {
    fly.alive = false;
    this.flies.delete(fly.id);
    const coins = fly.coins;
    this.scatter(fly);
    fly.coins = 0;
    if (killerId !== null) {
      const killer = this.flies.get(killerId);
      if (killer && killer.alive) {
        killer.kills += 1;
        events.push({ type: "kill", id: killer.id, victimId: fly.id });
      }
    }
    events.push({ type: "death", id: fly.id, owner: fly.owner, killerId, cause, coins, x: fly.x, y: fly.y });
  }

  /** Every coin a dead fly held lands on the floor along its body. Exactly. */
  private scatter(fly: Fly): void {
    let coins = fly.coins;
    if (coins <= 0) return;
    const points: Vec[] = [{ x: fly.x, y: fly.y }];
    const n = Math.min(fly.segments + 1, fly.path.length);
    for (let i = 0; i < n; i += 2) points.push(fly.path[i]);
    const count = Math.min(points.length, coins);
    const base = Math.floor(coins / count);
    let rem = coins - base * count;
    for (let i = 0; i < count; i++) {
      let v = base;
      if (rem > 0) {
        v += 1;
        rem -= 1;
      }
      if (v <= 0) break;
      const p = points[i];
      const jx = (this.rng() - 0.5) * 10;
      const jy = (this.rng() - 0.5) * 10;
      this.dropPellet(p.x + jx, p.y + jy, v);
      coins -= v;
    }
    if (coins > 0) {
      // Only reachable if points ran out; keep the invariant regardless.
      this.dropPellet(fly.x, fly.y, coins);
    }
  }

  private pickup(fly: Fly, events: SimEvent[]): void {
    const r = radiusFor(fly.coins);
    const reach = r + RULES.pickupMagnet + pelletRadius(1_000_000);
    const near = this.pelletsNear(fly.x, fly.y, reach);
    for (const p of near) {
      if (dist(fly.x, fly.y, p.x, p.y) > r + pelletRadius(p.value) + RULES.pickupMagnet) continue;
      fly.coins += p.value;
      this.gridRemove(p);
      this.pellets.delete(p.id);
      events.push({ type: "pickup", id: fly.id, pelletId: p.id, value: p.value });
    }
  }

  private extraction(fly: Fly, dt: number, events: SimEvent[]): void {
    if (fly.hatch >= 0 && this.hatchesOpenFor(fly)) {
      fly.extract += dt;
      if (fly.extract >= this.timing.extractSeconds) {
        fly.alive = false;
        this.flies.delete(fly.id);
        events.push({ type: "extracted", id: fly.id, owner: fly.owner, coins: fly.coins, x: fly.x, y: fly.y });
        fly.coins = 0;
      }
    } else if (fly.extract > 0) {
      fly.extract = Math.max(0, fly.extract - dt * RULES.extractDrainFactor);
    }
  }

  // ─────────────────────────── pellet grid ─────────────────────────────

  private gridAdd(p: Pellet): void {
    const key = cellKey(Math.floor(p.x / PELLET_CELL), Math.floor(p.y / PELLET_CELL));
    let bucket = this.pelletGrid.get(key);
    if (!bucket) {
      bucket = new Set();
      this.pelletGrid.set(key, bucket);
    }
    bucket.add(p.id);
  }

  private gridRemove(p: Pellet): void {
    const key = cellKey(Math.floor(p.x / PELLET_CELL), Math.floor(p.y / PELLET_CELL));
    const bucket = this.pelletGrid.get(key);
    if (bucket) {
      bucket.delete(p.id);
      if (bucket.size === 0) this.pelletGrid.delete(key);
    }
  }

  pelletsNear(x: number, y: number, radius: number): Pellet[] {
    const out: Pellet[] = [];
    const c0x = Math.floor((x - radius) / PELLET_CELL);
    const c1x = Math.floor((x + radius) / PELLET_CELL);
    const c0y = Math.floor((y - radius) / PELLET_CELL);
    const c1y = Math.floor((y + radius) / PELLET_CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket = this.pelletGrid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          const p = this.pellets.get(id);
          if (p && dist(x, y, p.x, p.y) <= radius) out.push(p);
        }
      }
    }
    return out;
  }

  /** Pellets inside an axis-aligned box — what a client's viewport needs. */
  pelletsInRect(x0: number, y0: number, x1: number, y1: number): Pellet[] {
    const out: Pellet[] = [];
    const c0x = Math.floor(x0 / PELLET_CELL);
    const c1x = Math.floor(x1 / PELLET_CELL);
    const c0y = Math.floor(y0 / PELLET_CELL);
    const c1y = Math.floor(y1 / PELLET_CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket = this.pelletGrid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          const p = this.pellets.get(id);
          if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(p);
        }
      }
    }
    return out;
  }

  /** Folds the smallest pellets into a neighbour so the floor never grows without bound. */
  private compactPellets(): void {
    const sorted = [...this.pellets.values()].sort((a, b) => a.value - b.value);
    const victims = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05)));
    for (const v of victims) {
      if (!this.pellets.has(v.id)) continue;
      const near = this.pelletsNear(v.x, v.y, PELLET_CELL * 1.5).filter((p) => p.id !== v.id);
      let target: Pellet | undefined = near[0];
      for (const p of near) if (p.value > (target?.value ?? -1)) target = p;
      if (!target) {
        for (const p of this.pellets.values()) {
          if (p.id !== v.id) {
            target = p;
            break;
          }
        }
      }
      if (!target) break;
      target.value += v.value;
      this.gridRemove(v);
      this.pellets.delete(v.id);
    }
  }
}
