/**
 * End-to-end proof against a running local server started with
 *
 *   CHAIN=off DEV_FAUCET=true DEV_AUTH=true TIME_SCALE=0.1 BOT_COUNT=6 npx tsx src/index.ts
 *
 * then `npx tsx scripts/e2e.mts` (SERVER=http://localhost:8790 to override).
 * It signs in, gets faucet money, stakes, flies, dies on the wall, checks the
 * books, stakes again, holds a hatch until it is out, and checks that every
 * coin is accounted for at every step.
 */
import { decodeState, type ServerMessage, type StateWire } from "../../web/src/shared/protocol";
import { RULES, hatchPositions } from "../../web/src/shared/rules";

const SERVER = process.env.SERVER ?? "http://localhost:8790";
const WS = SERVER.replace(/^http/, "ws") + "/ws";
const ADDRESS = "0x00000000000000000000000000000000000f1a7e";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

async function post(path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const res = await fetch(SERVER + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function get(path: string, token?: string): Promise<Record<string, unknown>> {
  const res = await fetch(SERVER + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return (await res.json()) as Record<string, unknown>;
}

class Socket {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  states: StateWire[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; timer: NodeJS.Timeout }[] = [];

  constructor() {
    this.ws = new WebSocket(WS);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const s = decodeState(ev.data);
        if (s) {
          this.states.push(s);
          if (this.states.length > 200) this.states.shift();
        }
        return;
      }
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      this.messages.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.pred(m)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(m);
        }
      }
    };
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("socket error"));
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  wait<T extends ServerMessage["t"]>(t: T, ms = 5000, extra?: (m: Extract<ServerMessage, { t: T }>) => boolean): Promise<Extract<ServerMessage, { t: T }>> {
    const pred = (m: ServerMessage) => m.t === t && (!extra || extra(m as Extract<ServerMessage, { t: T }>));
    const already = this.messages.find(pred);
    if (already) return Promise.resolve(already as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout waiting for ${t}`));
      }, ms);
      this.waiters.push({ pred, resolve: resolve as (m: ServerMessage) => void, timer });
    });
  }

  latest(): StateWire | undefined {
    return this.states[this.states.length - 1];
  }

  me(): StateWire["flies"][number] | undefined {
    const s = this.latest();
    return s ? s.flies.find((f) => f.id === s.myId) : undefined;
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n1. Status and sign-in");
  const status = await get("/status");
  check("status answers", typeof status.alive === "number", JSON.stringify(status).slice(0, 200));
  check("chain is off for this test", status.live === false);
  const auth = await post("/auth/dev", { address: ADDRESS });
  const token = String(auth.token ?? "");
  check("dev session issued", token.length === 64, JSON.stringify(auth));

  console.log("\n2. Faucet: 100 tokens in the lobby, 1 000 in the pot");
  // The database may not be fresh: everything below is measured as a delta.
  const before = (await get("/me", token)) as { lobbyCoins?: number };
  const lobby0 = before.lobbyCoins ?? 0;
  const fa = await post("/dev/faucet", { address: ADDRESS, tokens: "100" });
  check("faucet added 10 000 coins to the lobby", fa.lobbyCoins === lobby0 + 10_000, JSON.stringify(fa));
  const L = lobby0 + 10_000;
  await post("/dev/pot", { tokens: "1000" });
  const books0 = await get("/books");
  check("books balanced after the faucet", books0.balanced === true, JSON.stringify(books0));

  console.log("\n3. Socket: welcome, spectator state, then spawn");
  const s = new Socket();
  await s.open();
  s.send({ t: "hello", session: token });
  const welcome = await s.wait("welcome");
  check("welcome carries the rules and my lobby", welcome.rules.tickHz === RULES.tickHz && welcome.you?.lobbyCoins === L);
  check("welcome says the chain is off, honestly", welcome.live === false && typeof welcome.liveNote === "string");
  await sleep(600);
  check("spectator receives binary state", s.states.length > 5, `${s.states.length}`);
  check("bots are in the pit", (s.latest()?.flies.length ?? 0) > 0 || s.messages.some((m) => m.t === "roster" && (m.add?.length ?? 0) > 0));

  s.send({ t: "spawn", coins: 500, name: "E2E" });
  const err = await s.wait("error");
  check("a stake under the floor is refused", /between/.test(err.message), err.message);
  s.send({ t: "spawn", coins: 2_000, name: "E2E" });
  const spawned = await s.wait("spawned");
  check("spawned", spawned.id > 0);
  const you1 = await s.wait("you");
  check("lobby went down by the stake", you1.you.lobbyCoins === L - 2_000, `${you1.you.lobbyCoins}`);
  await sleep(300);
  const me = s.me();
  check("I am in the state with my coins", !!me && me.coins === 2_000, JSON.stringify(me));

  console.log("\n4. Input moves the fly; the wall kills it; coins hit the floor");
  const start = s.me()!;
  const outward = Math.atan2(start.y, start.x);
  const inputTimer = setInterval(() => s.send({ t: "input", a: outward, b: 0 }), 50);
  await sleep(700);
  const later = s.me()!;
  const moved = Math.hypot(later.x - start.x, later.y - start.y);
  check("the fly moved toward the wall", moved > 50, `${moved.toFixed(0)}`);
  const death = await s.wait("death", 40_000, (m) => m.mine);
  clearInterval(inputTimer);
  check("died on the wall", death.cause === "wall", death.cause);
  check("the death dropped exactly my coins", death.coins === 2_000, `${death.coins}`);
  const books1 = await get("/books");
  check("books still balanced after a death", books1.balanced === true, JSON.stringify(books1));

  console.log("\n5. Stake again, hold a hatch, get out with the coins");
  s.messages = [];
  s.send({ t: "spawn", coins: 1_500 });
  const spawned2 = await s.wait("spawned");
  check("spawned again", spawned2.id > spawned.id);
  const hatches = hatchPositions();
  let extracted: Extract<ServerMessage, { t: "extracted" }> | null = null;
  let died = false;
  const drive = setInterval(() => {
    const m = s.me();
    if (!m) return;
    // Nearest hatch; aim at its centre, then circle tightly inside it.
    let best = hatches[0];
    for (const h of hatches) if (Math.hypot(h.x - m.x, h.y - m.y) < Math.hypot(best.x - m.x, best.y - m.y)) best = h;
    const d = Math.hypot(best.x - m.x, best.y - m.y);
    const a = Math.atan2(best.y - m.y, best.x - m.x) + (d < 60 ? 1.0 : 0);
    s.send({ t: "input", a, b: d > 400 ? 1 : 0 });
  }, 50);
  const outcome = await Promise.race([
    s.wait("extracted", 60_000, (m) => m.mine).then((m) => (extracted = m)),
    s.wait("death", 60_000, (m) => m.mine).then(() => (died = true)),
  ]);
  clearInterval(drive);
  void outcome;
  check("made it out through a hatch (not killed on the way)", !!extracted && !died);
  if (extracted) {
    const e = extracted as Extract<ServerMessage, { t: "extracted" }>;
    check("extraction carried the coins held at the time", e.coins > 0 && e.net + e.toll === e.coins, JSON.stringify(e));
    const you2 = await s.wait("you", 5000, (m) => m.you.lobbyCoins !== L - 3_500);
    check("lobby grew by the net extraction", you2.you.lobbyCoins === L - 3_500 + e.net, `${you2.you.lobbyCoins} vs ${L - 3_500 + e.net}`);
  }
  const books2 = await get("/books");
  check("books balanced after an extraction", books2.balanced === true, JSON.stringify(books2));

  console.log("\n6. The bank refuses politely without a chain");
  const cash = await post("/cashout", {}, token);
  check("cash-out is refused with the reason", typeof cash.error === "string" && /chain|deposits/.test(String(cash.error)), JSON.stringify(cash));
  const me2 = await get("/me", token);
  check("/me shows the lobby", typeof me2.lobbyCoins === "number" && me2.live === false);

  console.log("\n7. Dropping the socket keeps the fly for the grace period");
  s.messages = [];
  s.send({ t: "spawn", coins: 1_000 });
  const spawned3 = await s.wait("spawned");
  await sleep(200);
  s.close();
  const s2 = new Socket();
  await s2.open();
  s2.send({ t: "hello", session: token });
  const welcome2 = await s2.wait("welcome");
  check("reconnecting reattaches the same fly", welcome2.flyId === spawned3.id, `${welcome2.flyId} vs ${spawned3.id}`);
  await sleep(300);
  check("the reattached fly still flies", s2.me()?.id === spawned3.id);
  s2.close();

  await sleep(300);
  const books3 = await get("/books");
  check("books balanced with a fly still in the pit", books3.balanced === true, JSON.stringify(books3));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
