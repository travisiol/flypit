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
  /** The arena server (HTTP + WebSocket on the same origin). */
  server: (process.env.NEXT_PUBLIC_FLYPIT_SERVER ?? "http://localhost:8790").replace(/\/$/, ""),
  /** Deployed contract addresses. Empty until the day they exist. */
  arenaAddress: (process.env.NEXT_PUBLIC_FLYPIT_ARENA ?? "") as `0x${string}` | "",
  tokenAddress: (process.env.NEXT_PUBLIC_FLYPIT_TOKEN ?? "") as `0x${string}` | "",
} as const;

export const socketUrl = site.server.replace(/^http/, "ws") + "/ws";
