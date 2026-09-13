/** Small vector helpers shared by the simulation and the renderer. */

export interface Vec {
  x: number;
  y: number;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Shortest signed difference between two angles, in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Turn `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * The body of a fly is the trail of its head, sampled every `spacing`
 * units. `path[0]` is the newest sample and always lies within `spacing`
 * of the head. Given a new head position this inserts as many samples as
 * the head has moved past, then trims the tail to `maxPoints`.
 *
 * It is deliberately a pure function of the head positions fed to it: the
 * server and the client both run it, so a client that has seen every head
 * position of a fly holds exactly the server's body without ever being
 * sent the body itself.
 */
export function advancePath(path: Vec[], headX: number, headY: number, spacing: number, maxPoints: number): void {
  if (path.length === 0) {
    path.push({ x: headX, y: headY });
  }
  let guard = 0;
  while (guard++ < 64) {
    const p0 = path[0];
    const dx = headX - p0.x;
    const dy = headY - p0.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < spacing) break;
    const k = spacing / d;
    path.unshift({ x: p0.x + dx * k, y: p0.y + dy * k });
  }
  if (path.length > maxPoints) path.length = maxPoints;
}

/**
 * Where body circle `k` (0 = right behind the head) sits, given a head
 * that may be anywhere between two samples. Segment k is `(k + 1) * spacing`
 * of arc behind the head, which is between `path[k]` and `path[k + 1]`.
 * Returns false when the path is too short to place that segment yet — a
 * fly that just grew has to move before its body catches up.
 */
export function segmentPosition(
  path: Vec[],
  headX: number,
  headY: number,
  spacing: number,
  k: number,
  out: Vec,
): boolean {
  const tmp: Vec[] = [];
  const placed = bodyPositions(path, headX, headY, spacing, k + 1, tmp);
  if (placed <= k) return false;
  out.x = tmp[k].x;
  out.y = tmp[k].y;
  return true;
}

/**
 * Places up to `count` body circles along the polyline head → path[0] →
 * path[1] → …, one every `spacing` of arc, into `out` (objects are reused).
 * Returns how many were placed: fewer than `count` when the path is still
 * too short. Walking arc length rather than indexing samples means the head
 * may sit anywhere — a beat behind the newest sample, as an interpolated
 * client draws it, or a boost's worth ahead — and the body still starts
 * exactly one spacing behind it.
 */
export function bodyPositions(path: Vec[], headX: number, headY: number, spacing: number, count: number, out: Vec[]): number {
  let placed = 0;
  let target = spacing;
  let px = headX;
  let py = headY;
  let acc = 0;
  for (let i = 0; i < path.length && placed < count; i++) {
    const qx = path[i].x;
    const qy = path[i].y;
    const seg = Math.sqrt((qx - px) * (qx - px) + (qy - py) * (qy - py));
    while (placed < count && acc + seg >= target) {
      const f = seg > 0 ? (target - acc) / seg : 0;
      let o = out[placed];
      if (!o) {
        o = { x: 0, y: 0 };
        out[placed] = o;
      }
      o.x = px + (qx - px) * f;
      o.y = py + (qy - py) * f;
      placed++;
      target += spacing;
    }
    acc += seg;
    px = qx;
    py = qy;
  }
  return placed;
}

/** Deterministic PRNG (mulberry32) so tests and replays agree. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
