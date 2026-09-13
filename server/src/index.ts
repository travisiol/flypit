import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { assertConfig, chainConfigured, config, liveNote } from "./config";
import { resolveSession } from "./auth";
import { startChainWatcher, stopChainWatcher, signerAddress } from "./chain";
import * as db from "./db";
import { clientIp, handleHttp } from "./http";
import { Arena, type Client } from "./arena";
import type { ClientMessage } from "../../web/src/shared/protocol";

/**
 * Boot: one HTTP server for the JSON routes, one WebSocket server on the
 * same port for the pit. `ws://host/ws` is the only socket path.
 */

assertConfig();

// Whatever the last run left in the arena goes back where it came from
// before the world exists, so no coin is ever lost to a crash.
const recovered = db.recoverCheckpoint();
if (recovered.players > 0 || recovered.floor > 0) {
  console.log(
    `[boot] recovered the last arena: ${recovered.players} player(s) refunded ${recovered.coins} coins, ${recovered.floor} floor/bot coins back to the pot`,
  );
}

const arena = new Arena();
arena.start();

const server = createServer((req, res) => {
  void handleHttp(req, res, arena);
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2048 });

wss.on("connection", (ws: WebSocket, req) => {
  const origin = req.headers.origin;
  if (config.origin !== "*" && origin && origin !== config.origin) {
    ws.close(1008, "origin");
    return;
  }
  const client: Client = arena.connect(ws, clientIp(req));
  let greeted = false;

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      if (greeted) return;
      greeted = true;
      const address = resolveSession(typeof msg.session === "string" ? msg.session : null);
      arena.hello(client, address);
      return;
    }
    if (!greeted) return;
    if (msg.t === "input") arena.input(client, msg.a, msg.b);
    else if (msg.t === "spawn") arena.spawnRequest(client, msg.coins, msg.name);
    else if (msg.t === "ping") arena.send(client, { t: "pong", n: Number(msg.n) || 0, serverTime: arena.world.time });
  });

  ws.on("close", () => arena.disconnect(client));
  ws.on("error", () => arena.disconnect(client));
});

startChainWatcher((address) => arena.refreshYou(address));
setInterval(() => db.prune(), 10 * 60_000).unref();

server.listen(config.port, () => {
  console.log(`[boot] FLYPIT arena on :${config.port} — ws://localhost:${config.port}/ws`);
  console.log(`[boot] chain ${chainConfigured() ? `on (arena ${config.arenaAddress}, signer ${signerAddress})` : `off — ${liveNote()}`}`);
  console.log(`[boot] toll ${config.exitTollBps} bps, bots ${config.botCount}, rain ${config.rainPerMinute}/min, time scale ${config.timeScale}`);
  if (config.devFaucet) console.log("[boot] DEV_FAUCET is on: POST /dev/faucet {address, tokens}");
  if (config.devAuth) console.log("[boot] DEV_AUTH is on: POST /auth/dev {address}");
});

function shutdown(signal: string): void {
  console.log(`[stop] ${signal}: draining the arena`);
  stopChainWatcher();
  const d = arena.drain();
  console.log(`[stop] ${d.players} player(s) refunded ${d.coins} coins, ${d.floor} coins back to the pot`);
  const b = db.books(0);
  console.log(`[stop] books ${b.drift === 0n ? "balanced" : `DRIFT ${b.drift.toString()}`}`);
  for (const c of wss.clients) c.close(1001, "restart");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
