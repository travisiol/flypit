/**
 * Everything the server reads from the environment, with the defaults a
 * fresh checkout runs on. Nothing here is secret except PAYOUT_SIGNER_KEY.
 */

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isKey = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);

export const config = {
  port: Number(env("PORT", "8790")),
  /** Where the SQLite file lives. */
  dbPath: env("DB_PATH", "./data/flypit.sqlite"),
  /** Allowed browser origin for HTTP and WebSocket. "*" in development. */
  origin: env("ORIGIN", "*"),
  /** Shown in the wallet when signing in. */
  appName: env("APP_NAME", "FLYPIT"),
  /**
   * The built page (`web/out`) to serve next to the API, so one process is
   * the whole game. Empty = auto: `../web/out` if it exists, else API only.
   */
  staticDir: env("STATIC_DIR"),
  sessionDays: Number(env("SESSION_DAYS", "7")),

  // ── The chain ───────────────────────────────────────────────────────
  /**
   * "on"  — deposits are read from the Arena contract's events and vouchers
   *         are signed. Needs ARENA_ADDRESS, TOKEN_ADDRESS, PAYOUT_SIGNER_KEY.
   * "off" — no chain at all. Nothing can enter the lobby unless DEV_FAUCET
   *         is on, and nothing can ever be claimed. For local play and tests.
   */
  chain: env("CHAIN", "off") as "on" | "off",
  rpcUrl: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  chainId: Number(env("CHAIN_ID", "4663")),
  arenaAddress: env("ARENA_ADDRESS"),
  tokenAddress: env("TOKEN_ADDRESS"),
  tokenSymbol: env("TOKEN_SYMBOL", "FLYPIT"),
  tokenDecimals: Number(env("TOKEN_DECIMALS", "18")),
  /** Block to start reading events from on a fresh database. */
  startBlock: Number(env("START_BLOCK", "0")),
  /** Seconds between two polls of the chain. */
  chainPollSeconds: Number(env("CHAIN_POLL_SECONDS", "4")),
  /** Blocks behind the head we consider final. Arbitrum Orbit reorgs are rare; 2 is a cushion. */
  confirmations: Number(env("CONFIRMATIONS", "2")),
  /**
   * Development convenience. In production this belongs in a signer
   * service or a KMS, never in a file on the game server.
   */
  payoutSignerKey: env("PAYOUT_SIGNER_KEY"),
  /** How long a signed voucher stays valid. */
  voucherMinutes: Number(env("VOUCHER_MINUTES", "30")),

  // ── The pit ─────────────────────────────────────────────────────────
  /**
   * Basis points kept from every extraction (300 = 3 %). The default is
   * zero: the pit is strictly zero-sum and the project lives off the
   * token's own trade fee. Whatever it is, the UI shows it.
   */
  exitTollBps: Number(env("EXIT_TOLL_BPS", "0")),
  /** Address credited with the toll. Claims it with a voucher like anyone else. */
  treasuryAddress: env("TREASURY_ADDRESS").toLowerCase(),
  /**
   * Flies the server plays itself so the pit is never empty. They carry
   * coins only if the pot can stake them, and they never extract.
   */
  botCount: Number(env("BOT_COUNT", "18")),
  /** Rain from the pot, in pellets per minute. 0 disables rain. */
  rainPerMinute: Number(env("RAIN_PER_MINUTE", "30")),
  /** Seconds between two arena checkpoints (who holds what) written to disk. */
  checkpointSeconds: Number(env("CHECKPOINT_SECONDS", "5")),
  /**
   * Speed multiplier for local play: 0.1 makes the 60 s minimum stay 6 s
   * and the 8 s hold 0.8 s. Never set it in production.
   */
  timeScale: Number(env("TIME_SCALE", "1")),

  // ── Development doors ───────────────────────────────────────────────
  /** `POST /dev/faucet` credits a lobby without a deposit. Local chains only. */
  devFaucet: env("DEV_FAUCET") === "true",
  /** `POST /auth/dev` opens a session without a signature. Tests only. */
  devAuth: env("DEV_AUTH") === "true",
};

export function chainConfigured(): boolean {
  return (
    config.chain === "on" &&
    isAddress(config.arenaAddress) &&
    isAddress(config.tokenAddress) &&
    isKey(config.payoutSignerKey)
  );
}

/** Why the chain is off, in words a player can act on. */
export function liveNote(): string | null {
  if (config.chain !== "on") return "The arena is running without a chain: deposits and cash-outs are off.";
  if (!isAddress(config.arenaAddress)) return "The Arena contract is not deployed yet.";
  if (!isAddress(config.tokenAddress)) return "The token address is not set yet.";
  if (!isKey(config.payoutSignerKey)) return "The arena has no signing key yet.";
  return null;
}

export function assertConfig(): void {
  if (config.chain === "on" && !chainConfigured()) {
    throw new Error(`CHAIN=on but the chain is not configured: ${liveNote()}`);
  }
  if (config.exitTollBps < 0 || config.exitTollBps > 5_000) throw new Error("EXIT_TOLL_BPS must be between 0 and 5000");
  if (config.exitTollBps > 0 && !isAddress(config.treasuryAddress)) {
    throw new Error("EXIT_TOLL_BPS is set: TREASURY_ADDRESS must be the wallet that claims the toll");
  }
  if (!(config.timeScale > 0)) throw new Error("TIME_SCALE must be > 0");
  if (config.chain === "on" && config.timeScale !== 1) throw new Error("TIME_SCALE must be 1 when CHAIN=on");
  if (config.chain === "on" && config.devFaucet) throw new Error("DEV_FAUCET cannot be on together with CHAIN=on");
  if (config.tokenDecimals < 2 || config.tokenDecimals > 36) throw new Error("TOKEN_DECIMALS out of range");
}
