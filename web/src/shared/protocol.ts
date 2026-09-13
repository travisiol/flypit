/**
 * What crosses the socket. Control messages are JSON; the 20 Hz world
 * snapshot is a compact binary frame (see `encodeState` / `decodeState`)
 * because JSON at that rate is most of the bandwidth and none of the game.
 */
import type { Hatch, RULES } from "./rules";
import type { DeathCause, Timing } from "./sim";
import type { Vec } from "./geometry";

// ─────────────────────────── client → server ───────────────────────────

export type ClientMessage =
  | { t: "hello"; session?: string }
  | { t: "spawn"; coins: number; name?: string }
  | { t: "input"; a: number; b: 0 | 1 }
  | { t: "ping"; n: number };

// ─────────────────────────── server → client ───────────────────────────

export interface YouState {
  address: string;
  name: string | null;
  /** Whole coins sitting in the lobby: deposited or extracted, not in the arena. */
  lobbyCoins: number;
  /** Same balance in token wei, as a decimal string. */
  lobbyWei: string;
  /** Cumulative entitlement the server will sign vouchers up to. */
  claimableWei: string;
  /** Cumulative amount the chain has already paid this address. */
  claimedWei: string;
}

export interface RosterEntry {
  id: number;
  name: string;
  hue: number;
  bot: boolean;
}

export interface BoardRow {
  id: number;
  name: string;
  coins: number;
  kills: number;
}

export interface TokenInfo {
  symbol: string;
  decimals: number;
  address: string | null;
}

export type ServerMessage =
  | {
      t: "welcome";
      rules: typeof RULES;
      /** The waiting clocks actually in force (a local server may shorten them). */
      timing: Timing;
      hatches: Hatch[];
      exitTollBps: number;
      /** True when deposits are watched on chain and vouchers can be signed. */
      live: boolean;
      /** Why `live` is false, in words a player can act on. */
      liveNote: string | null;
      token: TokenInfo;
      arena: string | null;
      chainId: number;
      devFaucet: boolean;
      you: YouState | null;
      flyId: number | null;
    }
  | { t: "you"; you: YouState }
  | { t: "roster"; full?: boolean; add?: RosterEntry[]; remove?: number[] }
  | { t: "spawned"; id: number }
  | {
      t: "death";
      id: number;
      name: string;
      killerId: number | null;
      killerName: string | null;
      cause: DeathCause;
      coins: number;
      x: number;
      y: number;
      mine: boolean;
    }
  | {
      t: "extracted";
      id: number;
      name: string;
      coins: number;
      net: number;
      toll: number;
      x: number;
      y: number;
      mine: boolean;
    }
  | { t: "board"; top: BoardRow[]; alive: number; players: number; floor: number; pot: number }
  | { t: "error"; message: string }
  | { t: "pong"; n: number; serverTime: number };

// ───────────────────────────── binary state ─────────────────────────────

export const STATE_FRAME = 0x01;

export const FLAG_BOOST = 1;
export const FLAG_SHIELD = 2;
export const FLAG_IN_HATCH = 4;
export const FLAG_BOT = 8;
export const FLAG_HATCHES_OPEN = 16;
export const FLAG_ORPHAN = 32;

export interface FlyWire {
  id: number;
  x: number;
  y: number;
  angle: number;
  coins: number;
  flags: number;
  /** 0..1 */
  extract: number;
  segments: number;
  /** Full sampled trail when the server resyncs it, otherwise null. */
  path: Vec[] | null;
}

export interface PelletWire {
  id: number;
  x: number;
  y: number;
  value: number;
}

export interface StateWire {
  tick: number;
  time: number;
  camX: number;
  camY: number;
  myId: number;
  flies: FlyWire[];
  pellets: PelletWire[];
}

const ANGLE_SCALE = 10000;

export function encodeState(s: StateWire): ArrayBuffer {
  let size = 1 + 4 + 4 + 2 + 2 + 2 + 2;
  for (const f of s.flies) size += 2 + 8 + 2 + 4 + 1 + 1 + 2 + 2 + (f.path ? f.path.length * 4 : 0);
  size += 2 + s.pellets.length * 12;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o, STATE_FRAME);
  o += 1;
  v.setUint32(o, s.tick >>> 0);
  o += 4;
  v.setFloat32(o, s.time);
  o += 4;
  v.setInt16(o, clampI16(s.camX));
  o += 2;
  v.setInt16(o, clampI16(s.camY));
  o += 2;
  v.setUint16(o, s.myId & 0xffff);
  o += 2;
  v.setUint16(o, s.flies.length);
  o += 2;
  for (const f of s.flies) {
    v.setUint16(o, f.id & 0xffff);
    o += 2;
    v.setFloat32(o, f.x);
    o += 4;
    v.setFloat32(o, f.y);
    o += 4;
    v.setInt16(o, Math.round(f.angle * ANGLE_SCALE));
    o += 2;
    v.setUint32(o, Math.min(0xffffffff, Math.max(0, f.coins)) >>> 0);
    o += 4;
    v.setUint8(o, f.flags & 0xff);
    o += 1;
    v.setUint8(o, Math.round(Math.min(1, Math.max(0, f.extract)) * 255));
    o += 1;
    v.setUint16(o, f.segments & 0xffff);
    o += 2;
    const n = f.path ? f.path.length : 0;
    v.setUint16(o, n);
    o += 2;
    if (f.path) {
      for (const p of f.path) {
        v.setInt16(o, clampI16(p.x));
        o += 2;
        v.setInt16(o, clampI16(p.y));
        o += 2;
      }
    }
  }
  v.setUint16(o, s.pellets.length);
  o += 2;
  for (const p of s.pellets) {
    v.setUint32(o, p.id >>> 0);
    o += 4;
    v.setInt16(o, clampI16(p.x));
    o += 2;
    v.setInt16(o, clampI16(p.y));
    o += 2;
    v.setUint32(o, Math.min(0xffffffff, Math.max(0, p.value)) >>> 0);
    o += 4;
  }
  return buf;
}

export function decodeState(buf: ArrayBuffer): StateWire | null {
  const v = new DataView(buf);
  if (v.byteLength < 17 || v.getUint8(0) !== STATE_FRAME) return null;
  let o = 1;
  const tick = v.getUint32(o);
  o += 4;
  const time = v.getFloat32(o);
  o += 4;
  const camX = v.getInt16(o);
  o += 2;
  const camY = v.getInt16(o);
  o += 2;
  const myId = v.getUint16(o);
  o += 2;
  const flyCount = v.getUint16(o);
  o += 2;
  const flies: FlyWire[] = [];
  for (let i = 0; i < flyCount; i++) {
    const id = v.getUint16(o);
    o += 2;
    const x = v.getFloat32(o);
    o += 4;
    const y = v.getFloat32(o);
    o += 4;
    const angle = v.getInt16(o) / ANGLE_SCALE;
    o += 2;
    const coins = v.getUint32(o);
    o += 4;
    const flags = v.getUint8(o);
    o += 1;
    const extract = v.getUint8(o) / 255;
    o += 1;
    const segments = v.getUint16(o);
    o += 2;
    const n = v.getUint16(o);
    o += 2;
    let path: Vec[] | null = null;
    if (n > 0) {
      path = new Array(n);
      for (let k = 0; k < n; k++) {
        const px = v.getInt16(o);
        o += 2;
        const py = v.getInt16(o);
        o += 2;
        path[k] = { x: px, y: py };
      }
    }
    flies.push({ id, x, y, angle, coins, flags, extract, segments, path });
  }
  const pelletCount = v.getUint16(o);
  o += 2;
  const pellets: PelletWire[] = new Array(pelletCount);
  for (let i = 0; i < pelletCount; i++) {
    const id = v.getUint32(o);
    o += 4;
    const x = v.getInt16(o);
    o += 2;
    const y = v.getInt16(o);
    o += 2;
    const value = v.getUint32(o);
    o += 4;
    pellets[i] = { id, x, y, value };
  }
  return { tick, time, camX, camY, myId, flies, pellets };
}

function clampI16(n: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(n)));
}
