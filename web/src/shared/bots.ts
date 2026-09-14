/**
 * Flies the arena plays itself, so the first person in never lands in an
 * empty pit. They are real flies: they eat, they cut, they die and drop
 * what they carried. What they spawn with is whatever `stake()` hands
 * them — on the server that is coins drawn from the pot (none when the
 * pot is dry), in the browser's practice pit it is play money. They never
 * extract, so nothing ever leaves through a bot.
 *
 * Pure: no clock, no database, no sockets. The server and the practice
 * pit both drive it.
 */
import { RULES, bodyRadiusFor, radiusFor } from "./rules";
import { dist, wrapAngle } from "./geometry";
import { World, type Fly } from "./sim";
import { BOT_NAMES, hueForIndex } from "./names";

export interface BotOptions {
  /** How many to keep alive. */
  count: number;
  /** Coins for the next bot. Called at each spawn. */
  stake: () => number;
}

export class Bots {
  private readonly ids = new Set<number>();
  private readonly nextThink = new Map<number, number>();
  private readonly boostUntil = new Map<number, number>();
  private nameIndex = 0;
  private lastSpawnAt = -10;
  private serial = 0;

  constructor(
    private readonly world: World,
    private readonly opts: BotOptions,
  ) {}

  has(id: number): boolean {
    return this.ids.has(id);
  }

  count(): number {
    return this.ids.size;
  }

  /** Coins currently carried by bots. */
  coins(): number {
    let sum = 0;
    for (const id of this.ids) sum += this.world.flies.get(id)?.coins ?? 0;
    return sum;
  }

  onDeath(id: number): void {
    this.ids.delete(id);
    this.nextThink.delete(id);
    this.boostUntil.delete(id);
  }

  /** Keeps `count` bots alive, one spawn every half second at most. */
  maintain(): void {
    if (this.ids.size >= this.opts.count) return;
    if (this.world.time - this.lastSpawnAt < 0.5) return;
    this.lastSpawnAt = this.world.time;
    const coins = Math.max(0, Math.floor(this.opts.stake()));
    const name = BOT_NAMES[this.nameIndex % BOT_NAMES.length];
    this.nameIndex += 1;
    this.serial += 1;
    const fly = this.world.spawn({ owner: `bot:${this.serial}`, name, hue: hueForIndex(this.serial * 5 + 3), bot: true, coins });
    this.ids.add(fly.id);
    this.nextThink.set(fly.id, this.world.time);
  }

  /** One decision per bot every 0.15–0.35 s. */
  think(): void {
    const now = this.world.time;
    for (const id of this.ids) {
      const fly = this.world.flies.get(id);
      if (!fly || !fly.alive) {
        this.onDeath(id);
        continue;
      }
      const due = this.nextThink.get(id) ?? 0;
      if (now < due) continue;
      this.nextThink.set(id, now + 0.15 + Math.random() * 0.2);
      this.decide(fly, now);
    }
  }

  private decide(fly: Fly, now: number): void {
    const r = radiusFor(fly.coins);
    const nearby = this.neighbours(fly, 1400);

    // 1. Clearance along seven rays fanning ±75° around the heading.
    const rays = [-1.3, -0.85, -0.45, 0, 0.45, 0.85, 1.3];
    const clearance = rays.map((off) => this.clearance(fly, fly.angle + off, nearby, r));
    const ahead = clearance[3];

    let target = fly.angle;
    let boost = false;

    const fromCenter = Math.hypot(fly.x, fly.y);
    if (fromCenter > RULES.arenaRadius * 0.82) {
      // 2. Too close to the wall: turn toward the centre.
      target = Math.atan2(-fly.y, -fly.x);
    } else if (ahead < 260) {
      // 3. Something in the way: take the clearest ray.
      let best = 0;
      for (let i = 1; i < rays.length; i++) if (clearance[i] > clearance[best]) best = i;
      target = fly.angle + rays[best];
      if (clearance[best] < 120) boost = fly.coins > RULES.boostMinCoins * 3 && Math.random() < 0.25;
    } else {
      // 4. Free: chase the juiciest pellet in reach, else wander.
      const pellets = this.world.pelletsNear(fly.x, fly.y, 900);
      let bestScore = 0;
      let bx = 0;
      let by = 0;
      for (const p of pellets) {
        const d = dist(fly.x, fly.y, p.x, p.y) + 30;
        const score = p.value / d;
        if (score > bestScore) {
          bestScore = score;
          bx = p.x;
          by = p.y;
        }
      }
      if (bestScore > 0) {
        const want = Math.atan2(by - fly.y, bx - fly.x);
        // Only go for it if that direction is clear enough.
        const c = this.clearance(fly, want, nearby, r);
        target = c > 200 ? want : fly.angle + rays[clearance.indexOf(Math.max(...clearance))];
      } else if (Math.random() < 0.3) {
        target = fly.angle + (Math.random() - 0.5) * 1.2;
      }
    }

    const until = this.boostUntil.get(fly.id) ?? 0;
    if (boost) this.boostUntil.set(fly.id, now + 0.6 + Math.random() * 0.8);
    this.world.setInput(fly.id, wrapAngle(target), boost || now < until);
  }

  /** Alive flies (players and bots) whose head or body is within `radius`, other than `fly`. */
  private neighbours(fly: Fly, radius: number): Fly[] {
    const out: Fly[] = [];
    for (const f of this.world.flies.values()) {
      if (f === fly || !f.alive) continue;
      // A whale's body can be near while its head is far: use the nearest path sample as well.
      let d = dist(fly.x, fly.y, f.x, f.y);
      if (d > radius) {
        for (let i = 0; i < f.path.length && d > radius; i += 8) d = Math.min(d, dist(fly.x, fly.y, f.path[i].x, f.path[i].y));
      }
      if (d <= radius) out.push(f);
    }
    return out;
  }

  /** Distance along `angle` before hitting a body, a head or the wall, capped at 600. */
  private clearance(fly: Fly, angle: number, others: Fly[], r: number): number {
    const MAX = 600;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let best = MAX;
    // Wall.
    for (let d = 40; d < MAX; d += 40) {
      if (Math.hypot(fly.x + cos * d, fly.y + sin * d) + r > RULES.arenaRadius - 20) {
        best = Math.min(best, d);
        break;
      }
    }
    for (const o of others) {
      const rb = bodyRadiusFor(o.coins) + r + 6;
      const n = Math.min(o.segments + 1, o.path.length);
      // The other head, where it is and where it will be in the next
      // 0.7 s: two flies aiming at one pellet must not meet halfway.
      const headRad = radiusFor(o.coins) + r + 30;
      const speed = o.boosting ? RULES.boostSpeed : RULES.baseSpeed;
      for (let k = 0; k <= 3; k++) {
        const aheadBy = speed * 0.7 * (k / 3);
        const hx = o.x + Math.cos(o.angle) * aheadBy;
        const hy = o.y + Math.sin(o.angle) * aheadBy;
        const dh = this.rayPointDistance(fly.x, fly.y, cos, sin, hx, hy, headRad, MAX);
        if (dh < best) best = dh;
      }
      for (let i = 0; i < n; i += 2) {
        const p = o.path[i];
        const d = this.rayPointDistance(fly.x, fly.y, cos, sin, p.x, p.y, rb, MAX);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** Distance along the ray at which a circle of radius `rad` at (px,py) is hit, or MAX. */
  private rayPointDistance(x: number, y: number, cos: number, sin: number, px: number, py: number, rad: number, MAX: number): number {
    const dx = px - x;
    const dy = py - y;
    const along = dx * cos + dy * sin;
    if (along < -rad || along > MAX) return MAX;
    const perp = Math.abs(dx * -sin + dy * cos);
    if (perp > rad) return MAX;
    return Math.max(0, along - Math.sqrt(rad * rad - perp * perp));
  }
}
