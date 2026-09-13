import { advancePath, angleDelta, type Vec } from "@/shared/geometry";
import { RULES, type Hatch } from "@/shared/rules";
import {
  FLAG_BOOST,
  FLAG_BOT,
  decodeState,
  type BoardRow,
  type RosterEntry,
  type ServerMessage,
  type StateWire,
  type YouState,
} from "@/shared/protocol";
import { socketUrl } from "@/lib/site";
import { getSession } from "@/lib/api";

/**
 * The browser's copy of the pit.
 *
 * Smoothness comes from one idea: the client draws the world a beat and a
 * half behind the server. Every snapshot is queued as a sample stamped
 * with its tick; a render clock, estimated from the arrival times and
 * smoothed, walks through the queue and the head is interpolated between
 * the two samples that bracket it. There is always a "next" sample to aim
 * at, so nothing lurches toward the latest packet the way a naive client
 * does at 20 Hz. If a sample is late the head carries on at its speed for
 * up to a tick and a half; if the tab was asleep the clock snaps.
 *
 * Bodies are rebuilt from the heads exactly as the server does it
 * (`advancePath`, fed one sample at a time as the clock consumes them), so
 * the wire carries a full body only when a fly comes into view and once a
 * second after that.
 *
 * Two audiences read this: the render loop (mutable fields, every frame)
 * and React (through `subscribe` / `version`, only when something a panel
 * shows has changed).
 */

export type Phase = "connecting" | "offline" | "spectating" | "playing" | "dead" | "extracted";

interface Sample {
  tick: number;
  x: number;
  y: number;
  angle: number;
  coins: number;
  flags: number;
  extract: number;
  segments: number;
  path: Vec[] | null;
}

export interface ClientFly {
  id: number;
  name: string;
  hue: number;
  bot: boolean;
  /** Rendered head, interpolated. */
  x: number;
  y: number;
  angle: number;
  /** As of the last sample the render clock consumed. */
  coins: number;
  flags: number;
  extract: number;
  segments: number;
  /** Sampled trail, newest first. See `advancePath`. */
  path: Vec[];
  /** Samples the render clock has not reached yet, oldest first. */
  queue: Sample[];
  /** The last sample consumed; the head is interpolated from it. */
  last: Sample | null;
  /** Newest sample tick received, to notice a fly that left the view. */
  newestTick: number;
  /** Wing-beat phase, so a swarm does not beat in unison. */
  phase: number;
}

export interface ClientPellet {
  id: number;
  x: number;
  y: number;
  value: number;
  /** Render-side drift toward a nearby head. */
  dx: number;
  dy: number;
  born: number;
}

/** A pellet that just vanished next to a head: it flies into that head. */
export interface EatenPellet {
  x: number;
  y: number;
  value: number;
  flyId: number;
  at: number;
}

export interface Burst {
  x: number;
  y: number;
  hue: number;
  coins: number;
  at: number;
}

export interface FeedItem {
  id: number;
  kind: "cut" | "wall" | "headon" | "timeout" | "extract" | "spawn";
  text: string;
  at: number;
}

export type Welcome = Extract<ServerMessage, { t: "welcome" }>;
export type DeathInfo = Extract<ServerMessage, { t: "death" }>;
export type ExtractInfo = Extract<ServerMessage, { t: "extracted" }>;

/** How far behind the newest tick the world is drawn. 1.5 ticks = 75 ms. */
const RENDER_DELAY_TICKS = 1.5;
/** Longest the head keeps going without a fresh sample. */
const MAX_EXTRAPOLATE_TICKS = 1.5;
/** A fly not sampled for this long has left the view. */
const STALE_TICKS = 6;

function nowTicks(): number {
  return (performance.now() / 1000) * RULES.tickHz;
}

export class GameClient {
  phase: Phase = "connecting";
  ws: WebSocket | null = null;
  welcome: Welcome | null = null;
  you: YouState | null = null;
  myId = 0;
  readonly flies = new Map<number, ClientFly>();
  readonly pellets = new Map<number, ClientPellet>();
  readonly roster = new Map<number, RosterEntry>();
  board: { top: BoardRow[]; alive: number; players: number; floor: number; pot: number } | null = null;
  hatches: Hatch[] = [];
  bursts: Burst[] = [];
  eaten: EatenPellet[] = [];
  feed: FeedItem[] = [];
  lastDeath: DeathInfo | null = null;
  lastExtract: ExtractInfo | null = null;
  error: string | null = null;
  tick = 0;
  serverTime = 0;
  camX = 0;
  camY = 0;
  /** Camera target from the last snapshot (spectator) or my head. */
  targetX = 0;
  targetY = 0;
  now = 0;
  ping = 0;
  /** Server time my current fly spawned at, for the hatch countdown. */
  spawnedAt = 0;
  version = 0;
  /** The tick the world is currently drawn at (fractional). */
  renderTick = 0;
  private clockAnchor = NaN;
  private listeners = new Set<() => void>();
  private feedSerial = 0;
  private inputAngle = 0;
  private inputBoost = false;
  private sentAngle = NaN;
  private sentBoost = false;
  private sentAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt = 0;
  private closedByUs = false;

  // ─────────────────────────────── React ────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private bump(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  // ─────────────────────────────── socket ───────────────────────────────

  connect(): void {
    this.closedByUs = false;
    this.phase = "connecting";
    this.bump();
    if (process.env.NODE_ENV !== "production") (window as unknown as { __flypit?: GameClient }).__flypit = this;
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl);
    } catch {
      this.phase = "offline";
      this.bump();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "hello", session: getSession() ?? undefined }));
      this.pingTimer = setInterval(() => {
        this.pingSentAt = performance.now();
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "ping", n: 1 }));
      }, 3000);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const s = decodeState(ev.data);
        if (s) this.applyState(s);
        return;
      }
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      // A socket we already replaced (dev double-mount, reconnect) must not
      // tear down the one that took its place.
      if (this.ws !== ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      if (this.closedByUs) return;
      this.phase = "offline";
      this.bump();
      setTimeout(() => {
        if (!this.closedByUs && !this.ws) this.connect();
      }, 2500);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  /** Reconnect with the session that is in storage now (after sign-in / sign-out). */
  reconnect(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
    this.flies.clear();
    this.pellets.clear();
    this.clockAnchor = NaN;
    setTimeout(() => this.connect(), 50);
  }

  dispose(): void {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        this.welcome = msg;
        this.hatches = msg.hatches;
        this.you = msg.you;
        this.myId = msg.flyId ?? 0;
        this.phase = this.myId ? "playing" : "spectating";
        this.error = null;
        this.bump();
        break;
      }
      case "you":
        this.you = msg.you;
        this.bump();
        break;
      case "roster": {
        if (msg.full) this.roster.clear();
        for (const r of msg.add ?? []) this.roster.set(r.id, r);
        for (const id of msg.remove ?? []) this.roster.delete(id);
        for (const f of this.flies.values()) {
          const r = this.roster.get(f.id);
          if (r) {
            f.name = r.name;
            f.hue = r.hue;
            f.bot = r.bot;
          }
        }
        break;
      }
      case "spawned":
        this.myId = msg.id;
        this.spawnedAt = this.serverTime;
        this.phase = "playing";
        this.lastDeath = null;
        this.lastExtract = null;
        this.error = null;
        this.sentAngle = NaN;
        this.bump();
        break;
      case "death": {
        const f = this.flies.get(msg.id);
        this.bursts.push({ x: msg.x, y: msg.y, hue: f?.hue ?? 0, coins: msg.coins, at: this.now });
        this.flies.delete(msg.id);
        const who = msg.name;
        const text =
          msg.cause === "wall"
            ? `${who} hit the wall`
            : msg.cause === "timeout"
              ? `${who} dropped off`
              : msg.cause === "headon"
                ? `${who} and ${msg.killerName ?? "?"} went head on`
                : `${msg.killerName ?? "?"} cut ${who}`;
        this.pushFeed(msg.cause, `${text} · ${(msg.coins / RULES.coinsPerToken).toFixed(2)} dropped`);
        if (msg.mine) {
          this.lastDeath = msg;
          this.myId = 0;
          this.phase = "dead";
        }
        this.bump();
        break;
      }
      case "extracted": {
        this.flies.delete(msg.id);
        this.pushFeed("extract", `${msg.name} bugged out with ${(msg.coins / RULES.coinsPerToken).toFixed(2)}`);
        if (msg.mine) {
          this.lastExtract = msg;
          this.myId = 0;
          this.phase = "extracted";
        }
        this.bump();
        break;
      }
      case "board":
        this.board = { top: msg.top, alive: msg.alive, players: msg.players, floor: msg.floor, pot: msg.pot };
        this.bump();
        break;
      case "error":
        this.error = msg.message;
        this.bump();
        break;
      case "pong":
        this.ping = Math.round(performance.now() - this.pingSentAt);
        this.serverTime = msg.serverTime;
        break;
    }
  }

  private pushFeed(kind: FeedItem["kind"], text: string): void {
    this.feed.push({ id: ++this.feedSerial, kind, text, at: this.now });
    if (this.feed.length > 6) this.feed.shift();
  }

  // ─────────────────────────────── state ────────────────────────────────

  private applyState(s: StateWire): void {
    this.tick = s.tick;
    this.serverTime = s.time;

    // Render clock: where the server's tick sits against our wall clock,
    // smoothed so jitter on the wire does not become jitter on screen.
    const anchor = s.tick - nowTicks();
    if (Number.isNaN(this.clockAnchor) || Math.abs(anchor - this.clockAnchor) > 3) this.clockAnchor = anchor;
    else this.clockAnchor += (anchor - this.clockAnchor) * 0.1;

    for (const w of s.flies) {
      let f = this.flies.get(w.id);
      const r = this.roster.get(w.id);
      if (!f) {
        f = {
          id: w.id,
          name: r?.name ?? "",
          hue: r?.hue ?? 0,
          bot: r?.bot ?? (w.flags & FLAG_BOT) !== 0,
          x: w.x,
          y: w.y,
          angle: w.angle,
          coins: w.coins,
          flags: w.flags,
          extract: w.extract,
          segments: w.segments,
          path: [],
          queue: [],
          last: null,
          newestTick: s.tick,
          phase: Math.random() * Math.PI * 2,
        };
        this.flies.set(w.id, f);
      }
      f.newestTick = s.tick;
      f.queue.push({
        tick: s.tick,
        x: w.x,
        y: w.y,
        angle: w.angle,
        coins: w.coins,
        flags: w.flags,
        extract: w.extract,
        segments: w.segments,
        path: w.path,
      });
      if (f.queue.length > 12) f.queue.shift();
      if (r) {
        f.name = r.name;
        f.hue = r.hue;
        f.bot = r.bot;
      }
    }

    const seen = new Set<number>();
    for (const w of s.pellets) {
      seen.add(w.id);
      let p = this.pellets.get(w.id);
      if (!p) {
        p = { id: w.id, x: w.x, y: w.y, value: w.value, dx: 0, dy: 0, born: this.now };
        this.pellets.set(w.id, p);
      } else {
        p.x = w.x;
        p.y = w.y;
        p.value = w.value;
      }
    }
    for (const [id, p] of this.pellets) {
      if (seen.has(id)) continue;
      this.pellets.delete(id);
      // Gone next to a head: it was eaten. Let it fly into the mouth.
      let eater = 0;
      let best = 90;
      for (const w of s.flies) {
        const d = Math.hypot(w.x - p.x, w.y - p.y);
        if (d < best) {
          best = d;
          eater = w.id;
        }
      }
      if (eater) this.eaten.push({ x: p.x + p.dx, y: p.y + p.dy, value: p.value, flyId: eater, at: this.now });
    }

    if (s.myId) {
      this.myId = s.myId;
    } else {
      this.targetX = s.camX;
      this.targetY = s.camY;
    }
  }

  /** Called by the render loop every frame with the wall clock in seconds. */
  update(now: number): void {
    this.now = now;
    const rt = nowTicks() + (Number.isNaN(this.clockAnchor) ? 0 : this.clockAnchor) - RENDER_DELAY_TICKS;
    this.renderTick = rt;

    for (const [id, f] of this.flies) {
      if (f.newestTick < rt - STALE_TICKS) {
        this.flies.delete(id);
        continue;
      }
      // Consume every sample the clock has passed. Each one advances the
      // body exactly the way the server did at that tick.
      while (f.queue.length && f.queue[0].tick <= rt) this.consume(f, f.queue.shift()!);
      // Nothing consumed yet (a fly that just appeared): start on its first sample.
      if (!f.last && f.queue.length) this.consume(f, f.queue.shift()!);
      const from = f.last;
      if (!from) continue;
      const next = f.queue[0];
      if (next && next.tick > from.tick) {
        const k = Math.min(1, Math.max(0, (rt - from.tick) / (next.tick - from.tick)));
        f.x = from.x + (next.x - from.x) * k;
        f.y = from.y + (next.y - from.y) * k;
        f.angle = from.angle + angleDelta(from.angle, next.angle) * k;
      } else {
        // Late sample: carry on at the last known speed, briefly.
        const dt = Math.min(MAX_EXTRAPOLATE_TICKS, Math.max(0, rt - from.tick)) / RULES.tickHz;
        const speed = from.flags & FLAG_BOOST ? RULES.boostSpeed : RULES.baseSpeed;
        f.x = from.x + Math.cos(from.angle) * speed * dt;
        f.y = from.y + Math.sin(from.angle) * speed * dt;
        f.angle = from.angle;
      }
    }

    const me = this.myId ? this.flies.get(this.myId) : undefined;
    if (me && me.last) {
      this.targetX = me.x;
      this.targetY = me.y;
      this.camX = me.x;
      this.camY = me.y;
    } else {
      this.camX += (this.targetX - this.camX) * 0.14;
      this.camY += (this.targetY - this.camY) * 0.14;
    }
    // Pellets lean toward a head about to eat them.
    if (me) {
      for (const p of this.pellets.values()) {
        const dx = me.x - p.x;
        const dy = me.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 110 && d > 1) {
          p.dx += ((dx / d) * 34 - p.dx) * 0.18;
          p.dy += ((dy / d) * 34 - p.dy) * 0.18;
        } else {
          p.dx *= 0.85;
          p.dy *= 0.85;
        }
      }
    }
    this.bursts = this.bursts.filter((b) => now - b.at < 1.2);
    this.eaten = this.eaten.filter((e) => now - e.at < 0.22);
    if (this.feed.length && now - this.feed[0].at > 9) {
      this.feed.shift();
      this.bump();
    }
  }

  private consume(f: ClientFly, smp: Sample): void {
    if (smp.path) f.path = smp.path;
    else advancePath(f.path, smp.x, smp.y, RULES.segmentSpacing, smp.segments + 4);
    f.last = smp;
    f.coins = smp.coins;
    f.flags = smp.flags;
    f.extract = smp.extract;
    f.segments = smp.segments;
  }

  me(): ClientFly | undefined {
    return this.myId ? this.flies.get(this.myId) : undefined;
  }

  /** Seconds until the hatches take my fly, 0 once they do. */
  stayLeft(): number {
    const minStay = this.welcome?.timing.minStaySeconds ?? RULES.minStaySeconds;
    return Math.max(0, minStay - (this.serverTime - this.spawnedAt));
  }

  // ─────────────────────────────── input ────────────────────────────────

  get aim(): number {
    return this.inputAngle;
  }

  setInput(angle: number, boost: boolean): void {
    this.inputAngle = angle;
    this.inputBoost = boost;
    this.flushInput();
  }

  /** Sends when the input changed, and at least four times a second as a heartbeat. */
  flushInput(): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN || this.phase !== "playing") return;
    const t = performance.now();
    const changed =
      Math.abs(angleDelta(this.sentAngle || 0, this.inputAngle)) > 0.01 || Number.isNaN(this.sentAngle) || this.inputBoost !== this.sentBoost;
    if (!changed && t - this.sentAt < 250) return;
    if (changed && t - this.sentAt < 45) return;
    this.sentAngle = this.inputAngle;
    this.sentBoost = this.inputBoost;
    this.sentAt = t;
    this.ws.send(JSON.stringify({ t: "input", a: Number(this.inputAngle.toFixed(4)), b: this.inputBoost ? 1 : 0 }));
  }

  spawn(coins: number, name?: string): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.error = null;
    this.bump();
    this.ws.send(JSON.stringify({ t: "spawn", coins, name: name || undefined }));
  }

  clearError(): void {
    this.error = null;
    this.bump();
  }

  setError(message: string): void {
    this.error = message;
    this.bump();
  }

  backToLobby(): void {
    if (this.phase === "dead" || this.phase === "extracted") {
      this.phase = "spectating";
      this.bump();
    }
  }
}
