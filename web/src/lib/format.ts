import { RULES } from "@/shared/rules";

/** Whole coins → "12.34" tokens. */
export function tokens(coins: number, digits = 2): string {
  const v = coins / RULES.coinsPerToken;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact coins for the HUD: 1 234 567 → "1.23M". */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

/** Wei string → tokens with up to 4 decimals. */
export function weiToTokens(wei: string | bigint, decimals: number, maxFrac = 4): string {
  let v: bigint;
  try {
    v = typeof wei === "bigint" ? wei : BigInt(wei);
  } catch {
    return "0";
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const f = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  const out = f ? `${w}.${f}` : w;
  return neg ? `-${out}` : out;
}

export function seconds(s: number): string {
  const n = Math.max(0, Math.ceil(s));
  if (n >= 60) return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  return `${n}s`;
}
