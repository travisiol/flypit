import { bodyPositions, type Vec } from "@/shared/geometry";
import { RULES, bodyRadiusFor, radiusFor } from "@/shared/rules";
import { pelletRadius } from "@/shared/sim";
import { FLAG_BOOST, FLAG_IN_HATCH, FLAG_ORPHAN, FLAG_SHIELD } from "@/shared/protocol";
import type { ClientFly, GameClient } from "./net";

/**
 * Canvas 2D renderer. Everything is drawn from geometry — no sprite files.
 *
 * A fly is two things. The trail is its body: one tapered, iridescent
 * tube stroked through the sampled path with round joins (never a chain
 * of circles), banded like an abdomen, lit from the top-left by a thin
 * specular line, with small wing pairs beating along it so it still reads
 * as a swarm. The head is an insect: two veined translucent wings drawn
 * at two beat positions so at 60 fps they buzz instead of flicker, a
 * metallic thorax, a striped abdomen, six legs, a head cap with compound
 * eyes and antennae. Everything scales with the fly's coin radius, so a
 * whale is the same animal, bigger.
 */

const OUT = "#04050a";
const FLOOR = "#0a0c14";
const GRID = "rgba(120, 140, 200, 0.075)";
const RIM = "#ff4d6d";
const HATCH = "#31f2c8";
const GOLD = "#ffd166";
/** Screen-space light direction for the body highlight (top-left). */
const LIGHT_X = -0.6;
const LIGHT_Y = -0.8;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private nebula: HTMLCanvasElement | null = null;
  private pelletSprites = new Map<number, HTMLCanvasElement>();
  private pts: Vec[] = [];
  scale = 1;
  camX = 0;
  camY = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
  }

  /** Sizes the backing store only; CSS owns the element's size. */
  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    this.nebula = null;
  }

  // ─────────────────────────────── frame ────────────────────────────────

  draw(g: GameClient, t: number): void {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    if (w === 0 || h === 0) return;

    const me = g.me();
    const viewW = me ? Math.min(2600, 860 + me.segments * 3.5) : 1900;
    const targetScale = w / viewW;
    this.scale += (targetScale - this.scale) * 0.06;
    const s = this.scale;
    this.camX = g.camX;
    this.camY = g.camY;
    const halfW = w / 2 / s;
    const halfH = h / 2 / s;
    const x0 = this.camX - halfW;
    const y0 = this.camY - halfH;
    const x1 = this.camX + halfW;
    const y1 = this.camY + halfH;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = OUT;
    ctx.fillRect(0, 0, w, h);

    // World space from here on.
    ctx.setTransform(s, 0, 0, s, w / 2 - this.camX * s, h / 2 - this.camY * s);

    // The floor: a disc, hex-gridded, with the rim that kills.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, RULES.arenaRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = FLOOR;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    this.drawHexGrid(x0, y0, x1, y1, s);
    ctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawNebula();
    ctx.setTransform(s, 0, 0, s, w / 2 - this.camX * s, h / 2 - this.camY * s);

    // Rim.
    ctx.beginPath();
    ctx.arc(0, 0, RULES.arenaRadius, 0, Math.PI * 2);
    ctx.lineWidth = 6 / s;
    ctx.strokeStyle = RIM;
    ctx.shadowColor = RIM;
    ctx.shadowBlur = 24;
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (const hatch of g.hatches) {
      if (hatch.x + hatch.r < x0 || hatch.x - hatch.r > x1 || hatch.y + hatch.r < y0 || hatch.y - hatch.r > y1) continue;
      this.drawHatch(hatch.x, hatch.y, hatch.r, t, g, s);
    }

    for (const p of g.pellets.values()) {
      const px = p.x + p.dx;
      const py = p.y + p.dy;
      if (px < x0 - 40 || px > x1 + 40 || py < y0 - 40 || py > y1 + 40) continue;
      this.drawPellet(px, py, p.value, t + p.id, 1);
    }
    for (const e of g.eaten) {
      const fly = g.flies.get(e.flyId);
      if (!fly) continue;
      const k = Math.min(1, Math.max(0, (t - e.at) / 0.22));
      const ease = k * k;
      this.drawPellet(e.x + (fly.x - e.x) * ease, e.y + (fly.y - e.y) * ease, e.value, t, 1 - k * 0.7);
    }

    // Bodies first, heads on top, mine last so it is never under a neighbour.
    const flies = [...g.flies.values()].sort((a, b) => a.coins - b.coins);
    for (const f of flies) if (f.last) this.drawTrail(f, t, s);
    for (const f of flies) if (f.last && f.id !== g.myId) this.drawHead(f, t, s, false);
    if (me && me.last) this.drawHead(me, t, s, true);
    for (const f of flies) if (f.last) this.drawLabel(f, s, f.id === g.myId);

    for (const b of g.bursts) this.drawBurst(b.x, b.y, b.hue, b.coins, t - b.at);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawMinimap(g);
  }

  // ─────────────────────────────── floor ────────────────────────────────

  private drawHexGrid(x0: number, y0: number, x1: number, y1: number, s: number): void {
    const ctx = this.ctx;
    const size = 64;
    const wHex = Math.sqrt(3) * size;
    const hStep = size * 1.5;
    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    const rowStart = Math.floor(y0 / hStep) - 1;
    const rowEnd = Math.ceil(y1 / hStep) + 1;
    const colStart = Math.floor(x0 / wHex) - 1;
    const colEnd = Math.ceil(x1 / wHex) + 1;
    for (let row = rowStart; row <= rowEnd; row++) {
      const cy = row * hStep;
      const offset = row % 2 === 0 ? 0 : wHex / 2;
      for (let col = colStart; col <= colEnd; col++) {
        const cx = col * wHex + offset;
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k + Math.PI / 6;
          const px = cx + Math.cos(a) * size;
          const py = cy + Math.sin(a) * size;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();
  }

  private drawNebula(): void {
    const ctx = this.ctx;
    if (!this.nebula) {
      const c = document.createElement("canvas");
      c.width = this.w;
      c.height = this.h;
      const n = c.getContext("2d")!;
      const g1 = n.createRadialGradient(this.w * 0.15, this.h * 0.1, 0, this.w * 0.15, this.h * 0.1, Math.max(this.w, this.h) * 0.7);
      g1.addColorStop(0, "rgba(120, 70, 255, 0.16)");
      g1.addColorStop(1, "rgba(120, 70, 255, 0)");
      n.fillStyle = g1;
      n.fillRect(0, 0, this.w, this.h);
      const g2 = n.createRadialGradient(this.w * 0.9, this.h * 0.95, 0, this.w * 0.9, this.h * 0.95, Math.max(this.w, this.h) * 0.7);
      g2.addColorStop(0, "rgba(49, 242, 200, 0.12)");
      g2.addColorStop(1, "rgba(49, 242, 200, 0)");
      n.fillStyle = g2;
      n.fillRect(0, 0, this.w, this.h);
      const v = n.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.35, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.8);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,0,0.55)");
      n.fillStyle = v;
      n.fillRect(0, 0, this.w, this.h);
      this.nebula = c;
    }
    ctx.drawImage(this.nebula, 0, 0);
  }

  private drawHatch(x: number, y: number, r: number, t: number, g: GameClient, s: number): void {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2);
    const fill = ctx.createRadialGradient(x, y, 0, x, y, r);
    fill.addColorStop(0, `rgba(49, 242, 200, ${0.14 + pulse * 0.05})`);
    fill.addColorStop(0.7, "rgba(49, 242, 200, 0.05)");
    fill.addColorStop(1, "rgba(49, 242, 200, 0)");
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 3 / s;
    ctx.strokeStyle = `rgba(49, 242, 200, ${0.5 + pulse * 0.4})`;
    ctx.shadowColor = HATCH;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 2 / s;
    ctx.strokeStyle = "rgba(49, 242, 200, 0.45)";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.72, t * 0.4, t * 0.4 + Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Whoever is holding it: a progress arc in their colour and the seconds left.
    let holding = false;
    for (const f of g.flies.values()) {
      if (!(f.flags & FLAG_IN_HATCH) || f.extract <= 0) continue;
      if (Math.hypot(f.x - x, f.y - y) > r + 30) continue;
      holding = true;
      ctx.lineWidth = 7 / s;
      ctx.lineCap = "round";
      ctx.strokeStyle = `hsl(${f.hue} 100% 62%)`;
      ctx.shadowColor = `hsl(${f.hue} 100% 62%)`;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(x, y, r + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f.extract);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineCap = "butt";
      const left = Math.max(0, (1 - f.extract) * RULES.extractSeconds);
      ctx.font = `700 ${Math.round(54 / Math.max(0.6, s))}px Archivo, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(left.toFixed(1), x, y);
    }
    if (!holding) {
      ctx.font = `600 ${Math.round(16 / Math.max(0.6, s))}px Archivo, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(49, 242, 200, 0.75)";
      ctx.fillText("HATCH", x, y);
    }
  }

  // ─────────────────────────────── pellets ──────────────────────────────

  private pelletSprite(rad: number): HTMLCanvasElement {
    const key = Math.round(rad * 2);
    let c = this.pelletSprites.get(key);
    if (c) return c;
    const px = key * 2;
    const glow = px * 1.6;
    c = document.createElement("canvas");
    c.width = c.height = Math.ceil(glow * 2 + 4);
    const n = c.getContext("2d")!;
    const cx = c.width / 2;
    const halo = n.createRadialGradient(cx, cx, px * 0.5, cx, cx, glow);
    halo.addColorStop(0, "rgba(255, 209, 102, 0.35)");
    halo.addColorStop(1, "rgba(255, 209, 102, 0)");
    n.fillStyle = halo;
    n.beginPath();
    n.arc(cx, cx, glow, 0, Math.PI * 2);
    n.fill();
    const coin = n.createRadialGradient(cx - px * 0.3, cx - px * 0.3, 0, cx, cx, px);
    coin.addColorStop(0, "#fff6c9");
    coin.addColorStop(0.45, GOLD);
    coin.addColorStop(1, "#b8780e");
    n.fillStyle = coin;
    n.beginPath();
    n.arc(cx, cx, px, 0, Math.PI * 2);
    n.fill();
    n.strokeStyle = "rgba(255, 240, 180, 0.7)";
    n.lineWidth = Math.max(1, px * 0.12);
    n.beginPath();
    n.arc(cx, cx, px * 0.68, 0, Math.PI * 2);
    n.stroke();
    this.pelletSprites.set(key, c);
    return c;
  }

  private drawPellet(x: number, y: number, value: number, seed: number, scale: number): void {
    const rad = pelletRadius(value);
    const sprite = this.pelletSprite(rad);
    const bob = Math.sin(seed * 0.7) * 1.5;
    const size = (sprite.width / 2) * scale;
    this.ctx.drawImage(sprite, x - size / 2, y - size / 2 + bob, size, size);
  }

  // ─────────────────────────────── the trail ────────────────────────────

  private drawTrail(f: ClientFly, t: number, s: number): void {
    const ctx = this.ctx;
    const rb = bodyRadiusFor(f.coins);
    const n = bodyPositions(f.path, f.x, f.y, RULES.segmentSpacing, f.segments, this.pts);
    if (n < 2) return;
    const pts = this.pts;
    const orphan = (f.flags & FLAG_ORPHAN) !== 0;
    const boosting = (f.flags & FLAG_BOOST) !== 0;
    const dim = orphan ? 0.45 : 1;
    const hue = f.hue;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 1. A wide, faint halo under the whole body — the cheap glow.
    ctx.globalAlpha = dim * (boosting ? 0.34 : 0.2);
    ctx.strokeStyle = `hsl(${hue} 100% 62%)`;
    ctx.lineWidth = rb * 3.4;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    // 2. The tube, tail to head, in short chunks so it can taper and shift
    //    hue along its length (iridescence): a gradient cannot follow a path.
    const CHUNK = 5;
    const lift = boosting ? 8 : 0;
    for (let i = n - 1; i > 0; i -= CHUNK) {
      const j = Math.max(0, i - CHUNK);
      const k = i / n; // 0 at the head, 1 at the tail
      const w = rb * 2 * (1 - 0.5 * k);
      ctx.globalAlpha = dim;
      ctx.lineWidth = w;
      ctx.strokeStyle = `hsl(${hue + 26 * k} ${82 - 16 * k}% ${52 - 15 * k + lift}%)`;
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      for (let q = i - 1; q >= j; q--) ctx.lineTo(pts[q].x, pts[q].y);
      ctx.stroke();
    }

    // 3. Abdomen bands: a dark ellipse across the tube every third sample.
    if (s > 0.3) {
      ctx.fillStyle = `hsl(${hue} 72% 22%)`;
      ctx.globalAlpha = dim * 0.5;
      for (let i = 2; i < n; i += 3) {
        const p = pts[i];
        const q = pts[i - 1];
        const dir = Math.atan2(p.y - q.y, p.x - q.x);
        const w = rb * 2 * (1 - 0.5 * (i / n));
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(dir);
        ctx.beginPath();
        ctx.ellipse(0, 0, w * 0.13, w * 0.47, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 4. Specular line, offset toward the light, thinner than the tube.
    if (s > 0.3) {
      ctx.strokeStyle = "rgba(255,255,255,0.26)";
      ctx.globalAlpha = dim;
      for (let i = n - 1; i > 0; i -= CHUNK) {
        const j = Math.max(0, i - CHUNK);
        const k = i / n;
        const w = rb * 2 * (1 - 0.5 * k);
        const ox = LIGHT_X * w * 0.27;
        const oy = LIGHT_Y * w * 0.27;
        ctx.lineWidth = w * 0.2;
        ctx.beginPath();
        ctx.moveTo(pts[i].x + ox, pts[i].y + oy);
        for (let q = i - 1; q >= j; q--) ctx.lineTo(pts[q].x + ox, pts[q].y + oy);
        ctx.stroke();
      }
    }

    // 5. A soft pulse of light sliding down the body every couple of seconds.
    if (n > 8) {
      const at = ((t * 0.55 + f.phase / 7) % 1) * (n + 8) - 4;
      const i0 = Math.max(1, Math.floor(at));
      const i1 = Math.min(n - 1, i0 + 5);
      if (i1 > i0) {
        ctx.globalAlpha = dim * 0.16;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = rb * 2 * (1 - 0.5 * (i0 / n)) * 0.9;
        ctx.beginPath();
        ctx.moveTo(pts[i0].x, pts[i0].y);
        for (let q = i0 + 1; q <= i1; q++) ctx.lineTo(pts[q].x, pts[q].y);
        ctx.stroke();
      }
    }

    // 6. Little wing pairs along the swarm, beating out of phase.
    if (s > 0.5) {
      for (let i = 3; i < n; i += 6) {
        const p = pts[i];
        const q = pts[i - 1];
        const dir = Math.atan2(q.y - p.y, q.x - p.x);
        const w = rb * (1 - 0.5 * (i / n));
        const beat = Math.sin(t * 36 + f.phase + i * 1.1) * 0.35;
        this.smallWing(p.x, p.y, dir, w * 1.6, w * 0.42, 0.6 + beat, dim * 0.18);
        this.smallWing(p.x, p.y, dir, w * 1.6, w * 0.42, -0.6 - beat, dim * 0.18);
      }
    }
    ctx.globalAlpha = 1;
  }

  private smallWing(x: number, y: number, dir: number, len: number, width: number, spread: number, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir + Math.PI + spread);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#e6f0ff";
    ctx.beginPath();
    ctx.ellipse(len * 0.5, 0, len * 0.5, width, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ─────────────────────────────── the head ─────────────────────────────

  private drawHead(f: ClientFly, t: number, s: number, mine: boolean): void {
    const ctx = this.ctx;
    const r = radiusFor(f.coins);
    const hue = f.hue;
    const orphan = (f.flags & FLAG_ORPHAN) !== 0;
    const boosting = (f.flags & FLAG_BOOST) !== 0;
    const dim = orphan ? 0.5 : 1;
    const detailed = s > 0.45;

    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.angle);
    ctx.globalAlpha = dim;

    // Under-glow.
    const glow = ctx.createRadialGradient(-r * 0.6, 0, 0, -r * 0.6, 0, r * 3.4);
    glow.addColorStop(0, `hsla(${hue}, 100%, 65%, ${mine ? 0.42 : 0.3})`);
    glow.addColorStop(1, `hsla(${hue}, 100%, 65%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(-r * 0.6, 0, r * 3.4, 0, Math.PI * 2);
    ctx.fill();

    if (boosting) {
      const streak = ctx.createLinearGradient(-r * 5, 0, -r * 1.5, 0);
      streak.addColorStop(0, `hsla(${hue}, 100%, 70%, 0)`);
      streak.addColorStop(1, `hsla(${hue}, 100%, 75%, 0.5)`);
      ctx.fillStyle = streak;
      ctx.beginPath();
      ctx.ellipse(-r * 3.2, 0, r * 2.2, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Wings: two beat positions each, so they blur into a buzz.
    const freq = boosting ? 62 : 40;
    const beat = Math.sin(t * freq + f.phase) * (boosting ? 0.34 : 0.26);
    for (const side of [1, -1]) {
      this.wing(r, side * (0.62 + beat), dim * 0.5, detailed);
      this.wing(r, side * (0.62 - beat), dim * 0.36, detailed);
    }

    // Legs, before the body so they come out from under it.
    if (detailed) {
      ctx.strokeStyle = `hsl(${hue} 55% 16%)`;
      ctx.lineWidth = r * 0.11;
      ctx.lineCap = "round";
      ctx.globalAlpha = dim * 0.85;
      const legs: [number, number, number][] = [
        [0.3, 0.45, 0.35],
        [0.0, 0.62, 1.15],
        [-0.4, 0.55, 1.95],
      ];
      for (const side of [1, -1]) {
        for (const [bx, by, a] of legs) {
          const kx = bx * r + Math.cos(side * a) * r * 0.9;
          const ky = by * side * r + Math.sin(side * a) * r * 0.9;
          const fx = kx + Math.cos(side * (a + 0.9)) * r * 0.8;
          const fy = ky + Math.sin(side * (a + 0.9)) * r * 0.8;
          ctx.beginPath();
          ctx.moveTo(bx * r, by * side * r);
          ctx.lineTo(kx, ky);
          ctx.lineTo(fx, fy);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = dim;
    }

    // Abdomen: behind the thorax, striped, the trail slips under it.
    const abd = ctx.createRadialGradient(-r * 1.0, -r * 0.3, r * 0.1, -r * 1.35, 0, r * 1.5);
    abd.addColorStop(0, `hsl(${hue} 92% ${boosting ? 70 : 62}%)`);
    abd.addColorStop(0.6, `hsl(${hue} 80% 44%)`);
    abd.addColorStop(1, `hsl(${hue} 70% 22%)`);
    ctx.fillStyle = abd;
    ctx.beginPath();
    ctx.ellipse(-r * 1.35, 0, r * 1.32, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsl(${hue} 70% 18%)`;
    ctx.globalAlpha = dim * 0.55;
    for (const [x, ry] of [
      [-0.95, 0.74],
      [-1.4, 0.68],
      [-1.85, 0.54],
      [-2.25, 0.36],
    ]) {
      ctx.beginPath();
      ctx.ellipse(x * r, 0, r * 0.09, r * ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = dim;
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.ellipse(-r * 1.15, -r * 0.34, r * 0.55, r * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Thorax: the metallic ball in the middle.
    const tho = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.05, 0, 0, r * 1.05);
    tho.addColorStop(0, `hsl(${hue} 95% ${boosting ? 86 : 80}%)`);
    tho.addColorStop(0.45, `hsl(${hue} 85% 55%)`);
    tho.addColorStop(1, `hsl(${hue} 70% 28%)`);
    ctx.fillStyle = tho;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.95, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `hsl(${hue} 60% 18%)`;
    ctx.lineWidth = r * 0.07;
    ctx.globalAlpha = dim * 0.7;
    ctx.stroke();
    ctx.globalAlpha = dim;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.28, -r * 0.4, r * 0.34, r * 0.17, -0.5, 0, Math.PI * 2);
    ctx.fill();

    // Head cap, eyes, antennae.
    const cap = ctx.createRadialGradient(r * 0.85, -r * 0.15, 0, r * 0.95, 0, r * 0.7);
    cap.addColorStop(0, `hsl(${hue} 85% 58%)`);
    cap.addColorStop(1, `hsl(${hue} 70% 24%)`);
    ctx.fillStyle = cap;
    ctx.beginPath();
    ctx.arc(r * 0.95, 0, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    for (const side of [1, -1]) {
      const ex = r * 1.05;
      const ey = side * r * 0.43;
      const eye = ctx.createRadialGradient(ex + r * 0.12, ey - side * r * 0.12, 0, ex, ey, r * 0.4);
      eye.addColorStop(0, "#ffa3a3");
      eye.addColorStop(0.5, "#ff2d55");
      eye.addColorStop(1, "#4d0818");
      ctx.fillStyle = eye;
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(ex + r * 0.13, ey - side * r * 0.13, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (detailed) {
      ctx.strokeStyle = `hsl(${hue} 50% 18%)`;
      ctx.lineWidth = r * 0.07;
      ctx.globalAlpha = dim * 0.7;
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(r * 1.45, side * r * 0.12);
        ctx.quadraticCurveTo(r * 1.85, side * r * 0.2, r * 2.0, side * r * 0.5);
        ctx.stroke();
      }
      ctx.globalAlpha = dim;
    }
    ctx.restore();

    if (f.flags & FLAG_SHIELD) {
      ctx.setLineDash([7, 7]);
      ctx.lineWidth = 2 / s;
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.arc(f.x, f.y, r * 2.6, t * 2, t * 2 + Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (mine) {
      ctx.lineWidth = 1.5 / s;
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.arc(f.x, f.y, r * 2.3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** One wing of the head, in the head's local frame (+x forward), pointing back-outward. */
  private wing(r: number, spread: number, alpha: number, detailed: boolean): void {
    const ctx = this.ctx;
    const len = r * 3.1;
    const width = r * 1.0;
    ctx.save();
    ctx.translate(-r * 0.35, Math.sign(spread) * r * 0.25);
    ctx.rotate(Math.PI + spread);
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(len * 0.35, 0, 0, len * 0.5, 0, len * 0.55);
    g.addColorStop(0, "rgba(235, 244, 255, 0.55)");
    g.addColorStop(0.7, "rgba(200, 220, 255, 0.22)");
    g.addColorStop(1, "rgba(180, 205, 255, 0.08)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(len * 0.52, 0, len * 0.52, width / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = r * 0.06;
    ctx.stroke();
    if (detailed) {
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = r * 0.045;
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(len * 0.45, side * width * 0.05, len * 0.92, side * width * 0.22);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len * 1.0, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLabel(f: ClientFly, s: number, mine: boolean): void {
    const ctx = this.ctx;
    if (s < 0.35 && !mine) return;
    const r = radiusFor(f.coins);
    const size = Math.round(13 / Math.max(0.5, s));
    ctx.font = `600 ${size}px Archivo, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3 / s;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineJoin = "round";
    const y = f.y - r * 2.9;
    const name = f.name || "…";
    const coins = (f.coins / RULES.coinsPerToken).toFixed(2);
    ctx.strokeText(name, f.x, y);
    ctx.fillStyle = f.bot ? "rgba(255,255,255,0.7)" : "#ffffff";
    ctx.fillText(name, f.x, y);
    ctx.font = `500 ${Math.round(size * 0.85)}px "Geist Mono", ui-monospace, monospace`;
    ctx.textBaseline = "top";
    ctx.strokeText(coins, f.x, y + 2 / s);
    ctx.fillStyle = GOLD;
    ctx.fillText(coins, f.x, y + 2 / s);
  }

  private drawBurst(x: number, y: number, hue: number, coins: number, age: number): void {
    const ctx = this.ctx;
    const k = Math.min(1, Math.max(0, age / 1.2));
    const ease = 1 - (1 - k) * (1 - k);
    const n = Math.min(30, 12 + Math.round(Math.sqrt(coins / 50)));
    ctx.globalAlpha = 1 - k;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ((i * 7919) % 10) * 0.05;
      const spread = 0.55 + (((i * 104729) % 100) / 100) * 0.45;
      const d = (30 + 250 * ease) * spread;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      ctx.fillStyle = i % 3 === 0 ? GOLD : `hsl(${hue} 90% 65%)`;
      ctx.beginPath();
      ctx.arc(px, py, 5 * (1 - k) + 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineWidth = 3 * (1 - k) + 0.5;
    ctx.strokeStyle = `hsla(${hue}, 90%, 65%, ${1 - k})`;
    ctx.beginPath();
    ctx.arc(x, y, 20 + 280 * ease, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ─────────────────────────────── minimap ──────────────────────────────

  private drawMinimap(g: GameClient): void {
    const ctx = this.ctx;
    const R = 62 * this.dpr;
    const cx = this.w - R - 18 * this.dpr;
    const cy = this.h - R - 18 * this.dpr;
    const k = R / RULES.arenaRadius;
    ctx.fillStyle = "rgba(10, 12, 20, 0.7)";
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.strokeStyle = "rgba(255, 77, 109, 0.8)";
    ctx.stroke();
    for (const h of g.hatches) {
      ctx.fillStyle = HATCH;
      ctx.beginPath();
      ctx.arc(cx + h.x * k, cy + h.y * k, 3 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    const top = new Set((g.board?.top ?? []).slice(0, 5).map((r) => r.id));
    for (const f of g.flies.values()) {
      if (f.id === g.myId || !top.has(f.id)) continue;
      ctx.fillStyle = `hsl(${f.hue} 90% 60%)`;
      ctx.beginPath();
      ctx.arc(cx + f.x * k, cy + f.y * k, 2.2 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    const me = g.me();
    const px = me ? me.x : g.camX;
    const py = me ? me.y : g.camY;
    ctx.fillStyle = me ? "#ffffff" : "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(cx + px * k, cy + py * k, 3 * this.dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}
