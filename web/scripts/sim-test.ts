/**
 * Headless proof of the arena rules. Runs the shared simulation at a fixed
 * step with no renderer and asserts what the site claims: coins are
 * conserved to the unit, a cut kills, the wall kills, the shield protects,
 * boosting sheds, hatches obey the minimum stay and the hold time, a
 * dropped socket is a death, and the wire format round-trips.
 *
 *   npx tsx scripts/sim-test.ts
 */
import { RULES, radiusFor, segmentsFor, turnRateFor, hatchPositions } from "../src/shared/rules";
import { World, type SimEvent } from "../src/shared/sim";
import { advancePath, segmentPosition, type Vec } from "../src/shared/geometry";
import { decodeState, encodeState, FLAG_BOOST, type StateWire } from "../src/shared/protocol";

const DT = 1 / RULES.tickHz;
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function run(world: World, ticks: number, onEvents?: (e: SimEvent[]) => void): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const ev = world.step(DT);
    all.push(...ev);
    onEvents?.(ev);
  }
  return all;
}

/** Moves a fly straight for `units` so it has a body laid out behind it. */
function layBody(world: World, id: number, units: number): void {
  const ticks = Math.ceil(units / (RULES.baseSpeed * DT));
  run(world, ticks);
}

// ───────────────────────── 1. conservation under chaos ─────────────────────────
section("1. Coins are conserved through 100 s of random play");
{
  const world = new World(7);
  let spawned = 0;
  let extracted = 0;
  const rnd = (n: number) => Math.floor(Math.random() * n);
  for (let i = 0; i < 24; i++) {
    const coins = 1_000 + rnd(50_000);
    world.spawn({ owner: `p${i}`, name: `P${i}`, hue: 0, bot: false, coins });
    spawned += coins;
  }
  let deaths = 0;
  let pickups = 0;
  let sheds = 0;
  let worstDrift = 0;
  for (let t = 0; t < 2000; t++) {
    for (const f of world.flies.values()) {
      if (t % 10 === 0) world.setInput(f.id, Math.random() * Math.PI * 2 - Math.PI, Math.random() < 0.3);
    }
    if (t % 50 === 0 && world.aliveFlies().length < 12) {
      const coins = 1_000 + rnd(20_000);
      world.spawn({ owner: `q${t}`, name: `Q${t}`, hue: 0, bot: false, coins });
      spawned += coins;
    }
    if (t % 40 === 0) {
      world.dropPellet((Math.random() - 0.5) * 3000, (Math.random() - 0.5) * 3000, RULES.rainPelletCoins);
      spawned += RULES.rainPelletCoins;
    }
    const ev = world.step(DT);
    for (const e of ev) {
      if (e.type === "death") deaths++;
      if (e.type === "pickup") pickups++;
      if (e.type === "shed") sheds++;
      if (e.type === "extracted") extracted += e.coins;
    }
    const drift = world.totalCoins() + extracted - spawned;
    worstDrift = Math.max(worstDrift, Math.abs(drift));
  }
  check("no coin created or destroyed (drift 0)", worstDrift === 0, `worst drift ${worstDrift}`);
  check("random play produced deaths", deaths > 0, `${deaths}`);
  check("random play produced pickups", pickups > 0, `${pickups}`);
  check("random play produced boost sheds", sheds > 0, `${sheds}`);
  check("pellet count stays under the cap", world.pellets.size <= RULES.maxPellets, `${world.pellets.size}`);
}

// ───────────────────────────── 2. a cut kills ──────────────────────────────
section("2. Head into another fly's body = you die, all your coins hit the floor");
{
  const world = new World(1);
  // A whale: its body is as long as the distance it has flown, so it keeps covering x=0 while it flies on.
  const b = world.spawn({ owner: "b", name: "B", hue: 0, bot: false, coins: 1_000_000, at: { x: -400, y: 0, angle: 0 } });
  layBody(world, b.id, 600); // B now stretches along y=0 from x≈-400 to x≈200
  // A starts 900 units north, heading south: it reaches B's body at ~5.6 s, well after its 3 s shield.
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 5_000, at: { x: 0, y: -900, angle: Math.PI / 2 } });
  run(world, Math.ceil(RULES.spawnShieldSeconds / DT)); // let the shield expire while B keeps flying
  const before = world.floorCoins();
  const ev = run(world, 80);
  const death = ev.find((e) => e.type === "death" && e.id === a.id);
  check("A died", !!death);
  check("cause is a cut", death?.type === "death" && death.cause === "cut", death ? JSON.stringify(death) : "no death");
  check("B is credited with the kill", death?.type === "death" && death.killerId === b.id);
  check("B.kills incremented", world.flies.get(b.id)?.kills === 1);
  check("A's 5 000 coins are all on the floor", world.floorCoins() - before === 5_000, `${world.floorCoins() - before}`);
  check("B is still alive", world.flies.get(b.id)?.alive === true);
}

// ──────────────────────────── 3. head on head ──────────────────────────────
section("3. Head on head: both die");
{
  const world = new World(2);
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 3_000, at: { x: -300, y: 0, angle: 0 } });
  const b = world.spawn({ owner: "b", name: "B", hue: 0, bot: false, coins: 3_000, at: { x: 300, y: 0, angle: Math.PI } });
  // Shield lasts 3 s; at 160 u/s they close 960 units in 3 s, so start them further apart.
  world.flies.get(a.id)!.x = -600;
  world.flies.get(b.id)!.x = 600;
  const ev = run(world, 120);
  const da = ev.find((e) => e.type === "death" && e.id === a.id);
  const db = ev.find((e) => e.type === "death" && e.id === b.id);
  check("A died head-on", da?.type === "death" && da.cause === "headon");
  check("B died head-on", db?.type === "death" && db.cause === "headon");
  check("6 000 coins on the floor", world.floorCoins() === 6_000, `${world.floorCoins()}`);
}

// ─────────────────────────────── 4. the wall ───────────────────────────────
section("4. The wall kills");
{
  const world = new World(3);
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 1_000, at: { x: 2_000, y: 0, angle: 0 } });
  const ev = run(world, 200);
  const d = ev.find((e) => e.type === "death" && e.id === a.id);
  check("died on the wall", d?.type === "death" && d.cause === "wall");
  check("coins dropped at the wall", world.floorCoins() === 1_000);
}

// ─────────────────────────────── 5. the shield ─────────────────────────────
section("5. Spawn shield: cannot die, cannot kill, cannot eat");
{
  const world = new World(4);
  const b = world.spawn({ owner: "b", name: "B", hue: 0, bot: false, coins: 1_000_000, at: { x: -400, y: 0, angle: 0 } });
  layBody(world, b.id, 600);
  world.dropPellet(0, -60, 50);
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 5_000, at: { x: 0, y: -80, angle: Math.PI / 2 } });
  // 80 units at 160 u/s = 0.5 s: A crosses B's body and the pellet well inside the 3 s shield.
  const ev = run(world, 20);
  check("shielded A crossed B's body alive", world.flies.get(a.id)?.alive === true);
  check("no death event", !ev.some((e) => e.type === "death"));
  check("shielded A did not eat the pellet", world.pellets.size === 1 && world.flies.get(a.id)?.coins === 5_000);
  // Wait out the shield, turn around, cross again: now it counts.
  run(world, 50);
  world.setInput(a.id, -Math.PI / 2, false);
  const ev2 = run(world, 120);
  const d = ev2.find((e) => e.type === "death" && e.id === a.id);
  check("after the shield the same crossing kills", d?.type === "death" && d.cause === "cut" && d.killerId === b.id);
}

// ─────────────────────────────── 6. pickups ────────────────────────────────
section("6. Pellets are picked up whole");
{
  const world = new World(5);
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 1_000, at: { x: 0, y: 0, angle: 0 } });
  world.dropPellet(700, 0, 123);
  world.dropPellet(720, 4, 77);
  const ev = run(world, Math.ceil(5 / DT));
  const picked = ev.filter((e) => e.type === "pickup").reduce((s, e) => s + (e.type === "pickup" ? e.value : 0), 0);
  check("both pellets eaten", picked === 200, `${picked}`);
  check("fly now holds 1 200 coins", world.flies.get(a.id)?.coins === 1_200);
  check("floor is empty", world.floorCoins() === 0);

  // The magnet: a pellet 55 units off the flight line is out of touching
  // range but inside the pull; one 200 units off is out of reach.
  const world2 = new World(5);
  const b = world2.spawn({ owner: "b", name: "B", hue: 0, bot: false, coins: 1_000, at: { x: -600, y: 0, angle: 0 } });
  world2.flies.get(b.id)!.shieldUntil = 0;
  const sideClose = world2.dropPellet(0, 55, 40);
  const sideFar = world2.dropPellet(0, 200, 40);
  const before = { x: sideClose.x, y: sideClose.y };
  let pulled = false;
  run(world2, Math.ceil(5 / DT), () => {
    const p = world2.pellets.get(sideClose.id);
    if (p && (p.x !== before.x || p.y !== before.y)) pulled = true;
  });
  check("a pellet inside the magnet is pulled toward the head", pulled);
  check("…and swallowed without the head touching where it lay", !world2.pellets.has(sideClose.id) && world2.flies.get(b.id)?.coins === 1_040);
  check("a pellet outside the magnet stays put", world2.pellets.get(sideFar.id)?.y === 200);
}

// ─────────────────────────────── 7. boosting ───────────────────────────────
section("7. Boosting sheds coins behind you; off below the floor");
{
  const world = new World(6);
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 10_000, at: { x: -1500, y: 0, angle: 0 } });
  run(world, 5);
  world.setInput(a.id, 0, true);
  const ev = run(world, Math.ceil(4 / DT));
  const shed = ev.filter((e) => e.type === "shed");
  const fly = world.flies.get(a.id)!;
  check("boost is applied", fly.boosting === true);
  check("boost shed coins", shed.length >= 15, `${shed.length} sheds`);
  check("shed coins equal the loss", world.floorCoins() === 10_000 - fly.coins, `${world.floorCoins()} vs ${10_000 - fly.coins}`);
  const behind = shed.every((e) => {
    const p = e.type === "shed" ? world.pellets.get(e.pelletId) : undefined;
    return !p || p.x < fly.x;
  });
  check("pellets land behind the head", behind);

  const world2 = new World(6);
  const tiny = world2.spawn({ owner: "t", name: "T", hue: 0, bot: false, coins: RULES.boostMinCoins - 1, at: { x: -1500, y: 0, angle: 0 } });
  world2.setInput(tiny.id, 0, true);
  run(world2, 40);
  check("a fly under the floor cannot boost", world2.flies.get(tiny.id)?.boosting === false && world2.floorCoins() === 0);
}

// ─────────────────────────────── 8. hatches ────────────────────────────────
section("8. Extraction: closed before the minimum stay, then hold 8 s, killable");
{
  const world = new World(8);
  const h = hatchPositions()[0];
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 5_000, at: { x: h.x - 60, y: h.y, angle: 0 } });
  // Circle inside the hatch: keep re-aiming so the fly loops in place.
  const loop = (ticks: number) =>
    run(world, ticks, () => {
      const f = world.flies.get(a.id);
      if (!f) return;
      const toCenter = Math.atan2(h.y - f.y, h.x - f.x);
      // aim slightly past the centre so it keeps circling
      world.setInput(a.id, toCenter + 0.9, false);
    });
  loop(Math.ceil((RULES.minStaySeconds - 2) / DT));
  const early = world.flies.get(a.id)!;
  check("still alive, inside the hatch", early.alive && early.hatch === 0, `hatch=${early.hatch}`);
  check("no progress before the minimum stay", early.extract === 0, `${early.extract}`);
  check("hatches are closed for it", !world.hatchesOpenFor(early));

  const ev = loop(Math.ceil((2 + RULES.extractSeconds + 1) / DT));
  const ex = ev.find((e) => e.type === "extracted");
  check("extracted after the stay + hold", !!ex && ex.type === "extracted" && ex.coins === 5_000, ex ? JSON.stringify(ex) : "none");
  check("the fly is gone", !world.flies.has(a.id));
  check("nothing on the floor", world.floorCoins() === 0);

  // Leaving drains the meter.
  const world2 = new World(9);
  const b = world2.spawn({ owner: "b", name: "B", hue: 0, bot: false, coins: 5_000, at: { x: h.x - 60, y: h.y, angle: 0 } });
  world2.flies.get(b.id)!.spawnedAt = -RULES.minStaySeconds; // pretend the stay is done
  run(world2, Math.ceil(3 / DT), () => {
    const f = world2.flies.get(b.id)!;
    world2.setInput(b.id, Math.atan2(h.y - f.y, h.x - f.x) + 0.9, false);
  });
  const mid = world2.flies.get(b.id)!.extract;
  check("meter fills while inside", mid > 2.5 && mid < 3.5, `${mid.toFixed(2)}`);
  world2.setInput(b.id, Math.atan2(h.y, h.x), false); // fly toward the centre of the arena = out of the hatch
  run(world2, Math.ceil(3 / DT));
  const after = world2.flies.get(b.id)!;
  check("meter drains once outside", after.hatch === -1 && after.extract === 0, `hatch=${after.hatch} extract=${after.extract}`);

  // Bots never extract.
  const world3 = new World(10);
  const bot = world3.spawn({ owner: "bot:1", name: "Gnat", hue: 0, bot: true, coins: 500, at: { x: h.x - 60, y: h.y, angle: 0 } });
  world3.flies.get(bot.id)!.spawnedAt = -1000;
  const ev3 = run(world3, Math.ceil(12 / DT), () => {
    const f = world3.flies.get(bot.id);
    if (f) world3.setInput(bot.id, Math.atan2(h.y - f.y, h.x - f.x) + 0.9, false);
  });
  check("a bot never extracts", !ev3.some((e) => e.type === "extracted") && world3.flies.get(bot.id)?.extract === 0);

  // Killable inside the hatch.
  const world4 = new World(11);
  // K lays its body straight through the hatch, 120 units south of its centre.
  const k = world4.spawn({ owner: "k", name: "K", hue: 0, bot: false, coins: 30_000, at: { x: h.x - 300, y: h.y + 120, angle: 0 } });
  layBody(world4, k.id, 600);
  // C is inside the hatch with its stay done and no shield, heading south into K's body.
  const c = world4.spawn({ owner: "c", name: "C", hue: 0, bot: false, coins: 5_000, at: { x: h.x, y: h.y - 60, angle: Math.PI / 2 } });
  world4.flies.get(c.id)!.spawnedAt = -RULES.minStaySeconds;
  world4.flies.get(c.id)!.shieldUntil = 0;
  const ev4 = run(world4, Math.ceil(2 / DT));
  const dc = ev4.find((e) => e.type === "death" && e.id === c.id);
  check("a fly holding a hatch can still be killed", dc?.type === "death" && dc.cause === "cut", ev4.map((e) => e.type).join(","));
  check("it was inside the hatch when it died", dc?.type === "death" && Math.hypot(dc.x - h.x, dc.y - h.y) < h.r);
}

// ─────────────────────────────── 9. orphans ────────────────────────────────
section("9. A dropped socket flies straight, then dies");
{
  const world = new World(12);
  const a = world.spawn({ owner: "a", name: "A", hue: 0, bot: false, coins: 2_000, at: { x: 0, y: 0, angle: 0 } });
  run(world, 10);
  world.flies.get(a.id)!.orphanedAt = world.time;
  world.setInput(a.id, 0, true);
  const ev = run(world, Math.ceil((RULES.disconnectGraceSeconds - 0.5) / DT));
  check("still alive inside the grace period", world.flies.get(a.id)?.alive === true);
  check("an orphan cannot boost", !ev.some((e) => e.type === "shed"));
  const ev2 = run(world, 20);
  const d = ev2.find((e) => e.type === "death" && e.id === a.id);
  check("died of timeout after the grace period", d?.type === "death" && d.cause === "timeout");
  check("its coins are on the floor", world.floorCoins() === 2_000);
}

// ─────────────────────────────── 10. geometry ──────────────────────────────
section("10. Bodies follow heads, whales turn slowly");
{
  const path: Vec[] = [];
  let x = 0;
  for (let i = 0; i < 100; i++) {
    x += 7;
    advancePath(path, x, 0, RULES.segmentSpacing, 40);
  }
  check("path capped at maxPoints", path.length === 40);
  const gaps = path.slice(1).map((p, i) => Math.abs(Math.hypot(p.x - path[i].x, p.y - path[i].y) - RULES.segmentSpacing));
  check("samples are exactly one spacing apart", Math.max(...gaps) < 1e-9);
  const out = { x: 0, y: 0 };
  const okSeg = segmentPosition(path, x, 0, RULES.segmentSpacing, 0, out);
  check("segment 0 sits one spacing behind the head", okSeg && Math.abs(x - out.x - RULES.segmentSpacing) < 1e-9, `${x - out.x}`);
  check("a 10 000-token whale turns slower than a 10-token fly", turnRateFor(segmentsFor(1_000_000)) < turnRateFor(segmentsFor(1_000)) / 2);
  check("length is capped", segmentsFor(1_000_000) === RULES.maxSegments);
  check("head radius grows slowly", radiusFor(1_000_000) < radiusFor(1_000) * 3);
}

// ─────────────────────────────── 11. wire format ───────────────────────────
section("11. The binary snapshot round-trips");
{
  const state: StateWire = {
    tick: 123456,
    time: 617.35,
    camX: -1234,
    camY: 987,
    myId: 42,
    flies: [
      { id: 42, x: 12.5, y: -700.25, angle: 1.2345, coins: 123_456, flags: FLAG_BOOST, extract: 0.5, segments: 30, path: [{ x: 1, y: 2 }, { x: -13, y: 2 }] },
      { id: 7, x: 0, y: 0, angle: -3.1, coins: 0, flags: 0, extract: 0, segments: 8, path: null },
    ],
    pellets: [{ id: 999, x: 100, y: -100, value: 25 }],
  };
  const decoded = decodeState(encodeState(state));
  check("decodes", !!decoded);
  check("tick/cam/myId", decoded?.tick === 123456 && decoded.camX === -1234 && decoded.camY === 987 && decoded.myId === 42);
  check("fly fields", decoded?.flies[0].coins === 123_456 && Math.abs(decoded.flies[0].angle - 1.2345) < 1e-3 && decoded.flies[0].flags === FLAG_BOOST);
  check("path resync carried", decoded?.flies[0].path?.length === 2 && decoded.flies[0].path[1].x === -13);
  check("head-only fly has no path", decoded?.flies[1].path === null);
  check("pellets", decoded?.pellets[0].value === 25 && decoded.pellets[0].x === 100);
}

// ─────────────────────────────── 12. compaction ────────────────────────────
section("12. The floor is bounded and merging keeps every coin");
{
  const world = new World(13);
  let dropped = 0;
  for (let i = 0; i < RULES.maxPellets + 500; i++) {
    const v = 1 + (i % 7);
    world.dropPellet((Math.random() - 0.5) * 5000, (Math.random() - 0.5) * 5000, v);
    dropped += v;
  }
  check("pellet count under the cap", world.pellets.size <= RULES.maxPellets, `${world.pellets.size}`);
  check("no coin lost in merging", world.floorCoins() === dropped, `${world.floorCoins()} vs ${dropped}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
