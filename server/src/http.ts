import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { parseUnits } from "viem";
import { chainConfigured, config, liveNote } from "./config";
import { devSession, issueNonce, resolveSession, verifySignature } from "./auth";
import { readChain, signVoucher, signerAddress } from "./chain";
import * as db from "./db";
import { RULES } from "../../web/src/shared/rules";
import type { Arena } from "./arena";

/**
 * The JSON routes that happen outside the socket: sign-in, the bank, the
 * numbers the landing shows, and the development faucet.
 */

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": config.origin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error("Body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

// ─────────────────────────────── the page ───────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

/** Resolved once at boot: the page folder, or null when this is an API-only process. */
export const staticRoot: string | null = (() => {
  const candidate = config.staticDir ? resolve(config.staticDir) : resolve(process.cwd(), "..", "web", "out");
  return existsSync(resolve(candidate, "index.html")) ? candidate : null;
})();

/**
 * Serves `web/out` — the static export of the page — so the arena is the
 * whole game on one origin: no CORS, no server URL to configure, and the
 * socket's `wss://` follows the page's `https://` by itself.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
  if (!staticRoot) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  const candidates = p.endsWith("/") ? [`${p}index.html`] : [p, `${p}.html`, `${p}/index.html`];
  let file: string | null = null;
  for (const c of candidates) {
    const full = resolve(staticRoot, `.${c}`);
    if (!full.startsWith(staticRoot + sep) && full !== staticRoot) continue; // no escaping the folder
    try {
      if (statSync(full).isFile()) {
        file = full;
        break;
      }
    } catch {
      /* next candidate */
    }
  }
  let status = 200;
  if (!file) {
    const notFound = resolve(staticRoot, "404.html");
    if (!existsSync(notFound)) return false;
    file = notFound;
    status = 404;
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = p.startsWith("/_next/static/");
  res.writeHead(status, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const address = resolveSession(h.slice(7).trim());
  return address;
}

export async function handleHttp(req: IncomingMessage, res: ServerResponse, arena: Arena): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return json(res, 204, {});

  try {
    if (method === "GET" && path === "/status") {
      const s = arena.stats();
      return json(res, 200, {
        ...s,
        live: chainConfigured(),
        liveNote: liveNote(),
        token: { symbol: config.tokenSymbol, decimals: config.tokenDecimals, address: config.tokenAddress || null },
        arena: config.arenaAddress || null,
        chainId: config.chainId,
        signer: signerAddress,
        exitTollBps: config.exitTollBps,
        rules: RULES,
        recent: db.recentHistory(20),
      });
    }

    if (method === "GET" && path === "/books") {
      const b = db.books(arena.stats().arenaCoins);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(b)) out[k] = (v as bigint).toString();
      return json(res, 200, { ...out, balanced: b.drift === 0n });
    }

    if (method === "POST" && path === "/auth/nonce") {
      const body = await readJson(req);
      return json(res, 200, issueNonce(String(body.address ?? "")));
    }

    if (method === "POST" && path === "/auth/verify") {
      const body = await readJson(req);
      const token = await verifySignature(
        String(body.address ?? ""),
        String(body.nonce ?? ""),
        String(body.message ?? ""),
        String(body.signature ?? ""),
      );
      return json(res, 200, { token });
    }

    if (method === "POST" && path === "/auth/dev") {
      const body = await readJson(req);
      const token = devSession(String(body.address ?? ""));
      return json(res, 200, { token });
    }

    if (method === "GET" && path === "/me") {
      const address = bearer(req);
      if (!address) return json(res, 401, { error: "Sign in first." });
      const you = arena.youState(address);
      const chain = await readChain(address);
      return json(res, 200, {
        ...you,
        chain: chain
          ? { claimed: chain.claimed.toString(), available: chain.available.toString(), paused: chain.paused, signerMatches: chain.signerMatches }
          : null,
        live: chainConfigured(),
        liveNote: liveNote(),
      });
    }

    if (method === "POST" && path === "/cashout") {
      const address = bearer(req);
      if (!address) return json(res, 401, { error: "Sign in first." });
      if (!chainConfigured()) return json(res, 409, { error: liveNote() });
      const acct = db.ensureAccount(address);
      if (acct.lobby_wei <= 0n) return json(res, 409, { error: "Nothing in your lobby to cash out." });
      const { moved, cumulative } = db.cashOut(address);
      db.recordHistory("cashout", address, acct.name, db.weiToCoins(moved));
      const voucher = await signVoucher(address, cumulative);
      arena.refreshYou(address);
      return json(res, 200, { voucher, moved: moved.toString() });
    }

    if (method === "POST" && path === "/voucher") {
      const address = bearer(req);
      if (!address) return json(res, 401, { error: "Sign in first." });
      if (!chainConfigured()) return json(res, 409, { error: liveNote() });
      const acct = db.ensureAccount(address);
      if (acct.claimable_wei <= 0n) return json(res, 409, { error: "Nothing has been cashed out yet." });
      const voucher = await signVoucher(address, acct.claimable_wei);
      return json(res, 200, { voucher });
    }

    if (method === "POST" && path === "/dev/faucet") {
      if (!config.devFaucet) return json(res, 404, { error: "Not found." });
      const body = await readJson(req);
      const address = String(body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return json(res, 400, { error: "Bad address." });
      const tokens = String(body.tokens ?? "100");
      db.faucet(address, parseUnits(tokens, config.tokenDecimals));
      arena.refreshYou(address);
      return json(res, 200, arena.youState(address));
    }

    if (method === "POST" && path === "/dev/pot") {
      if (!config.devFaucet) return json(res, 404, { error: "Not found." });
      const body = await readJson(req);
      const tokens = String(body.tokens ?? "1000");
      db.faucetPot(parseUnits(tokens, config.tokenDecimals));
      return json(res, 200, { pot: db.potWei().toString() });
    }

    if (serveStatic(req, res, path)) return;
    return json(res, 404, { error: "Not found." });
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
}
