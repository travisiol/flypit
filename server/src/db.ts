import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

/**
 * SQLite through Node's built-in driver: no native build step, one file on
 * disk. Every movement of money outside the arena goes through here, in
 * token wei kept as decimal strings (bigint end to end, never a float).
 *
 * Inside the arena money is whole coins held by the simulation in memory.
 * The `checkpoint` table shadows it so that a crash can never lose a coin:
 * `stake` and `extract` write their row in the same transaction as the
 * lobby, the periodic checkpoint refreshes every row from the live world,
 * and on the next boot whatever the table holds is handed back — coins to
 * their owner's lobby, the floor and the bots' coins to the pot.
 */

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS accounts (
    address TEXT PRIMARY KEY,
    lobby_wei TEXT NOT NULL DEFAULT '0',
    claimable_wei TEXT NOT NULL DEFAULT '0',
    claimed_wei TEXT NOT NULL DEFAULT '0',
    name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chain_events (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    address TEXT NOT NULL,
    amount_wei TEXT NOT NULL,
    block INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkpoint (
    owner TEXT PRIMARY KEY,
    coins INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    address TEXT,
    name TEXT,
    coins INTEGER NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS history_at ON history(at);
`);

export const COIN_WEI = 10n ** BigInt(config.tokenDecimals - 2);

export function coinsToWei(coins: number): bigint {
  if (!Number.isInteger(coins) || coins < 0) throw new Error(`coinsToWei: bad coins ${coins}`);
  return BigInt(coins) * COIN_WEI;
}

/** Whole coins a wei balance is worth, floored. Dust stays as wei in the lobby. */
export function weiToCoins(wei: bigint): number {
  return Number(wei / COIN_WEI);
}

// ─────────────────────────────── meta ────────────────────────────────

function metaGet(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

function metaSet(key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function potWei(): bigint {
  return BigInt(metaGet("pot_wei", "0"));
}

function setPot(v: bigint): void {
  if (v < 0n) throw new Error("pot would go negative");
  metaSet("pot_wei", v.toString());
}

export function lastBlock(): number {
  return Number(metaGet("last_block", String(config.startBlock)));
}

export function setLastBlock(n: number): void {
  metaSet("last_block", String(n));
}

function checkpointFloor(): number {
  return Number(metaGet("floor_coins", "0"));
}

function setCheckpointFloor(n: number): void {
  metaSet("floor_coins", String(Math.max(0, Math.floor(n))));
}

// ───────────────────────────── accounts ──────────────────────────────

export interface AccountRow {
  address: string;
  lobby_wei: bigint;
  claimable_wei: bigint;
  claimed_wei: bigint;
  name: string | null;
}

export function getAccount(address: string): AccountRow | null {
  const row = db.prepare("SELECT * FROM accounts WHERE address = ?").get(address.toLowerCase()) as
    | { address: string; lobby_wei: string; claimable_wei: string; claimed_wei: string; name: string | null }
    | undefined;
  if (!row) return null;
  return {
    address: row.address,
    lobby_wei: BigInt(row.lobby_wei),
    claimable_wei: BigInt(row.claimable_wei),
    claimed_wei: BigInt(row.claimed_wei),
    name: row.name,
  };
}

export function ensureAccount(address: string): AccountRow {
  const a = address.toLowerCase();
  db.prepare("INSERT OR IGNORE INTO accounts(address, created_at) VALUES (?, ?)").run(a, Date.now());
  return getAccount(a)!;
}

export function setName(address: string, name: string | null): void {
  ensureAccount(address);
  db.prepare("UPDATE accounts SET name = ? WHERE address = ?").run(name, address.toLowerCase());
}

function setLobby(address: string, v: bigint): void {
  if (v < 0n) throw new Error("lobby would go negative");
  db.prepare("UPDATE accounts SET lobby_wei = ? WHERE address = ?").run(v.toString(), address.toLowerCase());
}

// ─────────────────────────── chain events ────────────────────────────

export function chainEventSeen(txHash: string, logIndex: number): boolean {
  return !!db.prepare("SELECT 1 FROM chain_events WHERE tx_hash = ? AND log_index = ?").get(txHash, logIndex);
}

/** A `Deposited` event: the lobby grows by exactly what the contract received. */
export function creditDeposit(address: string, wei: bigint, txHash: string, logIndex: number, block: number): boolean {
  if (chainEventSeen(txHash, logIndex)) return false;
  const a = address.toLowerCase();
  db.exec("BEGIN");
  try {
    const acct = ensureAccount(a);
    db.prepare("INSERT INTO chain_events(tx_hash, log_index, kind, address, amount_wei, block) VALUES (?, ?, 'deposit', ?, ?, ?)").run(
      txHash,
      logIndex,
      a,
      wei.toString(),
      block,
    );
    setLobby(a, acct.lobby_wei + wei);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** A `Funded` event: the pot grows. */
export function creditFund(from: string, wei: bigint, txHash: string, logIndex: number, block: number): boolean {
  if (chainEventSeen(txHash, logIndex)) return false;
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO chain_events(tx_hash, log_index, kind, address, amount_wei, block) VALUES (?, ?, 'fund', ?, ?, ?)").run(
      txHash,
      logIndex,
      from.toLowerCase(),
      wei.toString(),
      block,
    );
    setPot(potWei() + wei);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** A `Claimed` event: remembered so the bank panel can show what the chain paid. */
export function noteClaim(address: string, paid: bigint, cumulative: bigint, txHash: string, logIndex: number, block: number): boolean {
  if (chainEventSeen(txHash, logIndex)) return false;
  const a = address.toLowerCase();
  db.exec("BEGIN");
  try {
    ensureAccount(a);
    db.prepare("INSERT INTO chain_events(tx_hash, log_index, kind, address, amount_wei, block) VALUES (?, ?, 'claim', ?, ?, ?)").run(
      txHash,
      logIndex,
      a,
      paid.toString(),
      block,
    );
    db.prepare("UPDATE accounts SET claimed_wei = ? WHERE address = ?").run(cumulative.toString(), a);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Development faucet: money that was never deposited. Recorded as a
 * pseudo-deposit so the books still balance — the "contract" in this mode
 * is imaginary and owes exactly what the faucet printed.
 */
export function faucet(address: string, wei: bigint): void {
  if (!config.devFaucet) throw new Error("The faucet is off.");
  const tx = `faucet:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  creditDeposit(address, wei, tx, 0, 0);
}

export function faucetPot(wei: bigint): void {
  if (!config.devFaucet) throw new Error("The faucet is off.");
  const tx = `faucet:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  creditFund("faucet", wei, tx, 0, 0);
}

// ──────────────────────────── the arena ──────────────────────────────

/** Lobby → arena. Returns false when the lobby cannot cover the stake. */
export function stake(address: string, coins: number): boolean {
  const a = address.toLowerCase();
  const wei = coinsToWei(coins);
  db.exec("BEGIN");
  try {
    const acct = ensureAccount(a);
    if (acct.lobby_wei < wei) {
      db.exec("ROLLBACK");
      return false;
    }
    setLobby(a, acct.lobby_wei - wei);
    db.prepare("INSERT INTO checkpoint(owner, coins) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET coins = coins + excluded.coins").run(a, coins);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface ExtractResult {
  net: number;
  toll: number;
}

/** Arena → lobby, minus the toll, which lands in the treasury's lobby. */
export function extract(address: string, coins: number): ExtractResult {
  const a = address.toLowerCase();
  const toll = Math.floor((coins * config.exitTollBps) / 10_000);
  const net = coins - toll;
  db.exec("BEGIN");
  try {
    const acct = ensureAccount(a);
    setLobby(a, acct.lobby_wei + coinsToWei(net));
    if (toll > 0) {
      const t = ensureAccount(config.treasuryAddress);
      setLobby(config.treasuryAddress, t.lobby_wei + coinsToWei(toll));
    }
    db.prepare("DELETE FROM checkpoint WHERE owner = ?").run(a);
    db.exec("COMMIT");
    return { net, toll };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Pot → arena, for rain and bot stakes. Returns false when the pot is short. */
export function drawPot(coins: number): boolean {
  const wei = coinsToWei(coins);
  db.exec("BEGIN");
  try {
    const pot = potWei();
    if (pot < wei) {
      db.exec("ROLLBACK");
      return false;
    }
    setPot(pot - wei);
    setCheckpointFloor(checkpointFloor() + coins);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Arena → pot (the floor and bot coins on a restart). */
export function returnToPot(coins: number): void {
  if (coins <= 0) return;
  setPot(potWei() + coinsToWei(coins));
}

/** Arena → lobby with no toll (a restart, not an extraction). */
export function refund(address: string, coins: number): void {
  if (coins <= 0) return;
  const acct = ensureAccount(address);
  setLobby(address, acct.lobby_wei + coinsToWei(coins));
}

/** Refreshes the crash shadow from the live world. */
export function writeCheckpoint(rows: { owner: string; coins: number }[], floorAndBots: number): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM checkpoint");
    const ins = db.prepare("INSERT INTO checkpoint(owner, coins) VALUES (?, ?)");
    for (const r of rows) ins.run(r.owner.toLowerCase(), r.coins);
    setCheckpointFloor(floorAndBots);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Hands back whatever the last checkpoint says was in the arena. Called
 * once at boot, before the world exists. Returns what it did for the log.
 */
export function recoverCheckpoint(): { players: number; coins: number; floor: number } {
  const rows = db.prepare("SELECT owner, coins FROM checkpoint").all() as { owner: string; coins: number }[];
  const floor = checkpointFloor();
  let coins = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      refund(r.owner, r.coins);
      coins += r.coins;
    }
    returnToPot(floor);
    db.exec("DELETE FROM checkpoint");
    setCheckpointFloor(0);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { players: rows.length, coins, floor };
}

// ─────────────────────────────── bank ────────────────────────────────

/** Lobby → claimable. Everything in the lobby becomes voucher entitlement. */
export function cashOut(address: string): { moved: bigint; cumulative: bigint } {
  const a = address.toLowerCase();
  db.exec("BEGIN");
  try {
    const acct = ensureAccount(a);
    const moved = acct.lobby_wei;
    const cumulative = acct.claimable_wei + moved;
    db.prepare("UPDATE accounts SET lobby_wei = '0', claimable_wei = ? WHERE address = ?").run(cumulative.toString(), a);
    db.exec("COMMIT");
    return { moved, cumulative };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ───────────────────────────── history ───────────────────────────────

export function recordHistory(type: string, address: string | null, name: string | null, coins: number, detail?: string): void {
  db.prepare("INSERT INTO history(at, type, address, name, coins, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    Date.now(),
    type,
    address,
    name,
    coins,
    detail ?? null,
  );
}

export function recentHistory(limit = 20): { at: number; type: string; name: string | null; coins: number; detail: string | null }[] {
  return db.prepare("SELECT at, type, name, coins, detail FROM history ORDER BY id DESC LIMIT ?").all(limit) as {
    at: number;
    type: string;
    name: string | null;
    coins: number;
    detail: string | null;
  }[];
}

// ───────────────────────────── the books ─────────────────────────────

export interface Books {
  deposited: bigint;
  funded: bigint;
  lobby: bigint;
  claimable: bigint;
  pot: bigint;
  arena: bigint;
  /** deposited + funded − (lobby + claimable + pot + arena). Must be 0. */
  drift: bigint;
}

/**
 * The one equation the whole ledger rests on. Every token that ever came
 * in is either waiting in a lobby, promised by a voucher, sitting in the
 * pot, or inside the arena. `arenaCoins` is the live world's total (or the
 * checkpoint's, when the world is not running).
 */
export function books(arenaCoins: number): Books {
  const sum = (sql: string): bigint => {
    const rows = db.prepare(sql).all() as { v: string }[];
    let t = 0n;
    for (const r of rows) t += BigInt(r.v);
    return t;
  };
  const deposited = sum("SELECT amount_wei AS v FROM chain_events WHERE kind = 'deposit'");
  const funded = sum("SELECT amount_wei AS v FROM chain_events WHERE kind = 'fund'");
  const lobby = sum("SELECT lobby_wei AS v FROM accounts");
  const claimable = sum("SELECT claimable_wei AS v FROM accounts");
  const pot = potWei();
  const arena = coinsToWei(arenaCoins);
  return { deposited, funded, lobby, claimable, pot, arena, drift: deposited + funded - (lobby + claimable + pot + arena) };
}

export function checkpointTotal(): number {
  const rows = db.prepare("SELECT COALESCE(SUM(coins), 0) AS s FROM checkpoint").get() as { s: number };
  return Number(rows.s) + checkpointFloor();
}

// ─────────────────────────────── auth ────────────────────────────────

export function insertNonce(nonce: string, address: string): void {
  db.prepare("INSERT INTO nonces(nonce, address, created_at) VALUES (?, ?, ?)").run(nonce, address, Date.now());
}

export function consumeNonce(nonce: string): string | null {
  const row = db.prepare("SELECT address, created_at FROM nonces WHERE nonce = ?").get(nonce) as
    | { address: string; created_at: number }
    | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce);
  if (Date.now() - row.created_at > 10 * 60_000) return null;
  return row.address;
}

export function insertSession(token: string, address: string): void {
  db.prepare("INSERT INTO sessions(token, address, created_at) VALUES (?, ?, ?)").run(token, address, Date.now());
}

export function sessionAddress(token: string): string | null {
  const row = db.prepare("SELECT address, created_at FROM sessions WHERE token = ?").get(token) as
    | { address: string; created_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > config.sessionDays * 86_400_000) return null;
  return row.address;
}

export function prune(): void {
  db.prepare("DELETE FROM nonces WHERE created_at < ?").run(Date.now() - 10 * 60_000);
  db.prepare("DELETE FROM sessions WHERE created_at < ?").run(Date.now() - config.sessionDays * 86_400_000);
}
