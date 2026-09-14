/**
 * One viewer's snapshot of the world: the flies and pellets inside a box
 * around the camera, with a fly's full body attached only when this viewer
 * has not seen it for a second (`known` remembers the tick of the last
 * full body per fly). The server builds one per socket per tick; the
 * browser's practice pit builds one for itself.
 */
import { radiusFor } from "./rules";
import type { World, Fly } from "./sim";
import { FLAG_BOOST, FLAG_BOT, FLAG_HATCHES_OPEN, FLAG_IN_HATCH, FLAG_ORPHAN, FLAG_SHIELD, type FlyWire, type StateWire } from "./protocol";

export const VIEW_HALF_W = 1800;
export const VIEW_HALF_H = 1250;
export const PATH_RESYNC_TICKS = 20;

export interface Viewer {
  camX: number;
  camY: number;
  /** The fly this viewer drives, if alive. */
  myId: number;
  /** fly id → tick of the last full body sent. Mutated. */
  known: Map<number, number>;
}

export function buildState(world: World, v: Viewer): StateWire {
  const x0 = v.camX - VIEW_HALF_W;
  const x1 = v.camX + VIEW_HALF_W;
  const y0 = v.camY - VIEW_HALF_H;
  const y1 = v.camY + VIEW_HALF_H;

  const flies: FlyWire[] = [];
  const seen = new Set<number>();
  for (const f of world.flies.values()) {
    if (!f.alive) continue;
    if (!touchesBox(f, x0, y0, x1, y1)) continue;
    seen.add(f.id);
    const last = v.known.get(f.id);
    const resync = last === undefined || world.tick - last >= PATH_RESYNC_TICKS;
    if (resync) v.known.set(f.id, world.tick);
    let flags = 0;
    if (f.boosting) flags |= FLAG_BOOST;
    if (world.time < f.shieldUntil) flags |= FLAG_SHIELD;
    if (f.hatch >= 0) flags |= FLAG_IN_HATCH;
    if (f.bot) flags |= FLAG_BOT;
    if (world.hatchesOpenFor(f)) flags |= FLAG_HATCHES_OPEN;
    if (f.orphanedAt !== null) flags |= FLAG_ORPHAN;
    flies.push({
      id: f.id,
      x: f.x,
      y: f.y,
      angle: f.angle,
      coins: f.coins,
      flags,
      extract: f.extract / world.timing.extractSeconds,
      segments: f.segments,
      path: resync ? f.path.slice(0, f.segments + 2) : null,
    });
  }
  for (const id of v.known.keys()) if (!seen.has(id)) v.known.delete(id);

  const me = v.myId ? world.flies.get(v.myId) : undefined;
  const pellets = world.pelletsInRect(x0, y0, x1, y1).map((p) => ({ id: p.id, x: p.x, y: p.y, value: p.value }));
  return {
    tick: world.tick,
    time: world.time,
    camX: v.camX,
    camY: v.camY,
    myId: me && me.alive ? me.id : 0,
    flies,
    pellets,
  };
}

function touchesBox(f: Fly, x0: number, y0: number, x1: number, y1: number): boolean {
  const pad = radiusFor(f.coins) + 40;
  if (f.x >= x0 - pad && f.x <= x1 + pad && f.y >= y0 - pad && f.y <= y1 + pad) return true;
  const n = Math.min(f.segments + 1, f.path.length);
  for (let i = 0; i < n; i += 6) {
    const p = f.path[i];
    if (p.x >= x0 - pad && p.x <= x1 + pad && p.y >= y0 - pad && p.y <= y1 + pad) return true;
  }
  return false;
}
