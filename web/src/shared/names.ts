/** Bot names and the hue wheel. Bot names are reserved: a player cannot take one. */
export const BOT_NAMES = [
  "Gnat", "Skeeter", "Wingnut", "Bluebottle", "Horsefly", "Botfly", "Maggie", "Fuzz",
  "Zzz", "Buzzsaw", "Blowfly", "Drone", "Midge", "Housefly", "Fruity", "Hover",
  "Tsetse", "Crane", "Mayfly", "Dobson", "Sawfly", "Snipe", "Lacewing", "Stonefly",
  "Damsel", "Marsh", "Robber", "Soldier", "Stable", "Flesh", "Cluster", "Deer",
] as const;

export const BOT_NAME_SET: ReadonlySet<string> = new Set(BOT_NAMES.map((n) => n.toLowerCase()));

/** Twelve hues, ordered so consecutive spawns never look alike. */
export const HUES = [0, 150, 300, 60, 210, 30, 180, 330, 90, 240, 120, 270] as const;

export function hueForIndex(i: number): number {
  return HUES[((i % HUES.length) + HUES.length) % HUES.length];
}

/** Player names: 2–14 visible characters, letters/digits/space/_-. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 14) return null;
  if (!/^[\p{L}\p{N} _\-]+$/u.test(s)) return null;
  if (BOT_NAME_SET.has(s.toLowerCase())) return null;
  return s;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
