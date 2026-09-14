/**
 * Every number the game is made of, in one place. The server, the client and
 * the headless test all import this file, so a rule can only ever have one
 * value. Distances are arena units; the arena is a disc of radius
 * `arenaRadius`. Money inside the arena is counted in whole "coins":
 * 1 coin = 1 / coinsPerToken of the token. Nothing here is fractional.
 */
export const RULES = {
  /** Simulation rate. The server steps the world this many times a second. */
  tickHz: 20,
  /** The arena is a disc. The wall kills. */
  arenaRadius: 2800,
  /** Cruise speed, units per second. */
  baseSpeed: 160,
  /** Boost speed. Boosting sheds coins behind you, see boostShed*. */
  boostSpeed: 320,
  /** Distance between two body samples. Bodies are chains of circles. */
  segmentSpacing: 12,
  /** A fly with no coins at all is still this long — it can still cut you. */
  minSegments: 8,
  /** Even a 10 000-token whale stops growing here, or it would wall the arena. */
  maxSegments: 400,
  /** Turn rate for a tiny fly, radians per second. Bigger flies turn slower. */
  turnRateBase: 4.2,

  /** 1 coin = 0.01 token. Stakes, pellets and tolls are all whole coins. */
  coinsPerToken: 100,
  /** Floor and ceiling of a single stake, in coins (10 and 10 000 tokens). */
  minStakeCoins: 1_000,
  maxStakeCoins: 1_000_000,

  /** After spawning you can neither die, kill nor eat for this long. */
  spawnShieldSeconds: 3,
  /** Hatches ignore you until you have been alive this long. */
  minStaySeconds: 60,
  /** Seconds you must hold inside a hatch, killable, before you are out. */
  extractSeconds: 8,
  /** Leaving a hatch drains the meter this many times faster than it fills. */
  extractDrainFactor: 3,
  /** Hatches sit on a ring at this fraction of the arena radius. */
  hatchCount: 6,
  hatchRingRadius: 0.62,
  hatchRadius: 140,

  /** Below this many coins boosting is off: you cannot shed what you do not have. */
  boostMinCoins: 200,
  /** Seconds between two sheds while boosting. */
  boostShedInterval: 0.25,
  /** Fraction of your coins each shed drops behind you, floored at one coin. */
  boostShedRate: 0.004,

  /** Extra reach when a pellet is finally swallowed, on top of the two radii. */
  pickupMagnet: 6,
  /**
   * Pellets this far from a head (plus the head's radius, ×3) are pulled
   * toward it and swallowed when they arrive — the slither magnet. The
   * pull is faster than a boosting fly, so nothing it reaches escapes.
   */
  magnetReach: 40,
  magnetSpeed: 400,
  /** Above this many pellets the smallest ones merge into their neighbours. */
  maxPellets: 4000,
  /** A fly whose socket dropped flies straight for this long, then dies. */
  disconnectGraceSeconds: 6,

  /** One rain pellet, in coins (0.25 token). The server rains only from the pot. */
  rainPelletCoins: 25,
  rainIntervalSeconds: 2,
  /** Bots spawn with this many coins drawn from the pot, or none if the pot is dry. */
  botStakeCoins: 500,
} as const;

/** How long a fly is for a given stack of coins. Sub-linear, like slither's mass. */
export function segmentsFor(coins: number): number {
  const n = RULES.minSegments + Math.floor(5 * Math.sqrt(Math.max(0, coins) / 100));
  return Math.min(RULES.maxSegments, n);
}

/** Head radius. Grows slowly — a whale is a long target, not a fat one. */
export function radiusFor(coins: number): number {
  return 11 + 2.2 * Math.log(1 + Math.max(0, coins) / 500);
}

/** How far a head pulls pellets in from, centre to centre. */
export function magnetRadiusFor(coins: number): number {
  return radiusFor(coins) * 3 + RULES.magnetReach;
}

/** Body circles are a bit thinner than the head. */
export function bodyRadiusFor(coins: number): number {
  return radiusFor(coins) * 0.85;
}

/** Radians per second a fly can turn. Long flies are slow to turn. */
export function turnRateFor(segments: number): number {
  return RULES.turnRateBase / (1 + segments / 180);
}

export interface Hatch {
  id: number;
  x: number;
  y: number;
  r: number;
}

/** The six hatches, fixed for the life of the arena. */
export function hatchPositions(): Hatch[] {
  const out: Hatch[] = [];
  const ring = RULES.arenaRadius * RULES.hatchRingRadius;
  for (let i = 0; i < RULES.hatchCount; i++) {
    const a = (Math.PI * 2 * i) / RULES.hatchCount + Math.PI / 6;
    out.push({ id: i, x: Math.round(Math.cos(a) * ring), y: Math.round(Math.sin(a) * ring), r: RULES.hatchRadius });
  }
  return out;
}

/** Whole coins → a token string with two decimals ("12.34"). */
export function coinsToTokens(coins: number): string {
  const sign = coins < 0 ? "-" : "";
  const abs = Math.abs(Math.round(coins));
  const whole = Math.floor(abs / RULES.coinsPerToken);
  const frac = abs % RULES.coinsPerToken;
  return `${sign}${whole.toLocaleString("en-US")}.${String(frac).padStart(2, "0")}`;
}

/** "12.34" or 12.34 → whole coins, floored. Returns null for garbage. */
export function tokensToCoins(input: string | number): number | null {
  const s = String(input).trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const frac = (f + "00").slice(0, 2);
  const coins = Number(w) * RULES.coinsPerToken + Number(frac);
  return Number.isFinite(coins) ? coins : null;
}
