/**
 * Everything that names the project lives here. A rename is these three
 * strings plus the NEXT_PUBLIC_FLYPIT_* env prefix and package names.
 */
export const site = {
  name: "FLYPIT",
  wordmark: "FLYPIT",
  ticker: "$FLYPIT",
  tagline: "Eat coins. Don't get cut. Bug out.",
  description:
    "A slither-style pit where the mass is money. Stake the token, eat what others drop, cut them before they cut you, and hold a hatch for eight seconds to leave with what you carry.",
  url: process.env.NEXT_PUBLIC_FLYPIT_URL ?? "https://flypit.gg",
  x: process.env.NEXT_PUBLIC_FLYPIT_X ?? "https://x.com/flypitgg",
  keywords: ["flypit", "slither", "io game", "onchain game", "robinhood chain", "pvp", "extraction"],
  /** Deployed contract addresses. Empty until the day they exist. */
  arenaAddress: (process.env.NEXT_PUBLIC_FLYPIT_ARENA ?? "") as `0x${string}` | "",
  tokenAddress: (process.env.NEXT_PUBLIC_FLYPIT_TOKEN ?? "") as `0x${string}` | "",
} as const;

const configuredServer = (process.env.NEXT_PUBLIC_FLYPIT_SERVER ?? "").replace(/\/$/, "");

/**
 * Where the arena is. Three cases, in order:
 *   1. `NEXT_PUBLIC_FLYPIT_SERVER` is set — the page was built for a known
 *      arena (a Vercel page talking to a Railway server, say);
 *   2. the page is served from somewhere that is not localhost — then the
 *      arena served it (the single-service deployment: the server hands
 *      out `web/out` itself), and it lives at the same origin;
 *   3. localhost — `next dev` on its own port, talking to the dev arena.
 */
export function serverUrl(): string {
  if (configuredServer) return configuredServer;
  if (typeof window !== "undefined") {
    const { hostname, origin, protocol } = window.location;
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (!local && (protocol === "http:" || protocol === "https:")) return origin;
  }
  return "http://localhost:8790";
}

export function socketUrl(): string {
  return serverUrl().replace(/^http/, "ws") + "/ws";
}
