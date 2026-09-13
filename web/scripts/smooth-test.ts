/**
 * Is the motion smooth? Feed the client 20 Hz snapshots with realistic
 * network jitter for a fly flying a circle, sample its rendered head at
 * 60 fps, and measure how even the per-frame steps are. A perfectly smooth
 * fly moves the same distance every frame: coefficient of variation ≈ 0.
 * The naive client (lerp toward the latest packet over one tick, what the
 * first version did) is measured the same way for comparison.
 *
 *   npx tsx scripts/smooth-test.ts
 */
import { GameClient } from "../src/game/net";
import { RULES } from "../src/shared/rules";
import { angleDelta, dist } from "../src/shared/geometry";
import type { StateWire } from "../src/shared/protocol";

const TICK_MS = 1000 / RULES.tickHz;
const FRAME_MS = 1000 / 60;
const SECONDS = 4;
const JITTER_MS = 14; // ± on every packet
const SPEED = RULES.baseSpeed;
const TURN = 1.1; // rad/s: a gentle circle

interface Head {
  x: number;
  y: number;
  angle: number;
}

/** The server: where the fly is at server tick n. */
function serverHead(tick: number): Head {
  const t = tick / RULES.tickHz;
  const radius = SPEED / TURN;
  return { x: Math.cos(TURN * t) * radius, y: Math.sin(TURN * t) * radius, angle: TURN * t + Math.PI / 2 };
}

function snapshot(tick: number, withPath: boolean): StateWire {
  const h = serverHead(tick);
  const path = withPath
    ? Array.from({ length: 40 }, (_, i) => {
        const k = serverHead(tick - i * (RULES.segmentSpacing / SPEED) * RULES.tickHz);
        return { x: k.x, y: k.y };
      })
    : null;
  return {
    tick,
    time: tick / RULES.tickHz,
    camX: 0,
    camY: 0,
    myId: 1,
    flies: [{ id: 1, x: h.x, y: h.y, angle: h.angle, coins: 5000, flags: 0, extract: 0, segments: 36, path }],
    pellets: [],
  };
}

/** Deterministic jitter so the two clients see the same network. */
function jitter(i: number): number {
  const u = Math.sin(i * 12.9898) * 43758.5453;
  return ((u - Math.floor(u)) * 2 - 1) * JITTER_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
  const client = new GameClient();
  const apply = (s: StateWire) => (client as unknown as { applyState(s: StateWire): void }).applyState(s);

  // The naive client, for comparison: same packets, lerp toward the newest over one tick.
  const naive = { x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0, at: 0, seeded: false };

  const t0 = performance.now();
  const totalTicks = SECONDS * RULES.tickHz;
  const arrivals: { at: number; tick: number }[] = [];
  for (let i = 0; i < totalTicks; i++) arrivals.push({ at: i * TICK_MS + jitter(i) + 100, tick: i });
  arrivals.sort((a, b) => a.at - b.at);

  const stepsNew: number[] = [];
  const stepsNaive: number[] = [];
  const attach: number[] = [];
  let prevNew: Head | null = null;
  let prevNaive: Head | null = null;
  let prevAt = 0;
  let frames = 0;
  let nextArrival = 0;
  const end = SECONDS * 1000 + 100;

  while (performance.now() - t0 < end) {
    const now = performance.now() - t0;
    while (nextArrival < arrivals.length && arrivals[nextArrival].at <= now) {
      const a = arrivals[nextArrival++];
      const s = snapshot(a.tick, a.tick % 20 === 0);
      apply(s);
      const h = s.flies[0];
      naive.fromX = naive.seeded ? naive.x : h.x;
      naive.fromY = naive.seeded ? naive.y : h.y;
      naive.toX = h.x;
      naive.toY = h.y;
      naive.at = now;
      naive.seeded = true;
    }
    client.update(now / 1000);
    const k = Math.min(1, (now - naive.at) / TICK_MS);
    naive.x = naive.fromX + (naive.toX - naive.fromX) * k;
    naive.y = naive.fromY + (naive.toY - naive.fromY) * k;

    const me = client.me();
    // Skip the warm-up second while the render clock settles. Node's timers
    // are not a 60 Hz vsync, so what is measured is speed (step / frame
    // time), which is what an even motion keeps constant.
    if (me && me.last && now > 1000) {
      const dt = (now - prevAt) / 1000;
      const cur: Head = { x: me.x, y: me.y, angle: me.angle };
      if (prevNew && dt > 0) stepsNew.push(dist(prevNew.x, prevNew.y, cur.x, cur.y) / dt);
      prevNew = cur;
      if (me.path.length) attach.push(dist(me.x, me.y, me.path[0].x, me.path[0].y));
      const cn: Head = { x: naive.x, y: naive.y, angle: 0 };
      if (prevNaive && dt > 0) stepsNaive.push(dist(prevNaive.x, prevNaive.y, cn.x, cn.y) / dt);
      prevNaive = cn;
      frames++;
    }
    prevAt = now;
    await sleep(FRAME_MS);
  }

  const stats = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    return { mean, sd, cv: sd / mean, min: Math.min(...xs), max: Math.max(...xs) };
  };
  const a = stats(stepsNew);
  const b = stats(stepsNaive);
  const ideal = SPEED;
  console.log(`${frames} frames sampled over ${SECONDS - 1} s, packets jittered ±${JITTER_MS} ms, true speed ${ideal} u/s\n`);
  console.log(`interpolated client : speed ${a.mean.toFixed(1)} ± ${a.sd.toFixed(1)} u/s  (CV ${(a.cv * 100).toFixed(1)} %, min ${a.min.toFixed(0)}, max ${a.max.toFixed(0)})`);
  console.log(`naive lerp-to-latest: speed ${b.mean.toFixed(1)} ± ${b.sd.toFixed(1)} u/s  (CV ${(b.cv * 100).toFixed(1)} %, min ${b.min.toFixed(0)}, max ${b.max.toFixed(0)})`);
  const maxAttach = Math.max(...attach);
  console.log(`head ↔ first body sample: max ${maxAttach.toFixed(1)} u (spacing ${RULES.segmentSpacing})\n`);

  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
    if (!ok) failed++;
  };
  check("speed is even: CV under 12 %", a.cv < 0.12, `${(a.cv * 100).toFixed(1)} %`);
  check("at least 3× steadier than the naive client", a.cv * 3 < b.cv, `${(a.cv * 100).toFixed(1)} vs ${(b.cv * 100).toFixed(1)}`);
  check("no freezes (slowest frame > 60 % of true speed)", a.min > ideal * 0.6, `${a.min.toFixed(0)}`);
  check("no leaps (fastest frame < 1.5× true speed)", a.max < ideal * 1.5, `${a.max.toFixed(0)}`);
  check("body stays attached to the head", maxAttach < RULES.segmentSpacing * 2.5, `${maxAttach.toFixed(1)}`);
  const me = client.me()!;
  check("heading follows the circle", Math.abs(angleDelta(me.angle, serverHead(client.tick).angle)) < 0.25);
  console.log(`\n${failed === 0 ? "smooth" : `${failed} failed`}`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
