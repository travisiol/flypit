# FLYPIT

**Eat coins. Don't get cut. Bug out.**

A slither-style PvP pit where the mass is money. You are a fly; your swarm is your bankroll. Stake the token, eat what others drop, cut them before they cut you — and to leave with what you carry, hold one of six hatches for eight seconds while everyone can see you doing it.

One screen: the pit is the page.

## The rules, in one breath

- Fly toward your pointer. **Hold click / Space to boost** — twice the speed, and it **sheds coins behind you**.
- **Your head touches any part of another fly → you die.** Head on head, both die. The wall kills.
- Everything you carried drops on the floor as gold pellets. Anyone eats it. **100 %, no house cut.**
- Size is not safety: a small fly cutting in front of a whale kills it, and the whale drops everything.
- **Leaving has no button.** After **60 s** alive, fly into a hatch and **hold it 8 s**, killable, no boost, with a ring showing everyone your colour and your countdown. Leave the circle and the meter drains, 3× faster than it fills.
- **Closing the tab is a death, not a withdrawal**: an orphaned fly flies straight for 6 s, then dies and drops its coins.
- 3 s spawn shield (cannot die, kill or eat). One wallet, one fly. A life is **10 – 10 000 tokens**.

Every number lives in [`web/src/shared/rules.ts`](web/src/shared/rules.ts) and is read by the server, the client, the tests and the "How it works" overlay. There is exactly one value for each.

## Where the money goes

```
wallet ──deposit──▶ Arena contract ──event──▶ your lobby (off chain, exact amount received)
lobby  ──stake────▶ your fly (whole coins, 1 coin = 0.01 token)
fly    ──death────▶ the floor (100 %)              fly ──hatch──▶ lobby (minus EXIT_TOLL_BPS, default 0)
lobby  ──cash out─▶ server-signed voucher ──claim──▶ wallet (you send the tx)
anyone ──fund─────▶ the pot ──rain / bot stakes──▶ the floor
```

**The one equation:** `deposited + funded = lobbies + vouchers + pot + arena`. The server asserts it every checkpoint and publishes it at `GET /books`. The sim test holds the arena to it after every tick; the e2e holds the ledger to it after every action.

**The pot** is the only source of new coins on the floor. It is funded by anyone calling `Arena.fund` — the token's fee wallet is the intended caller. Bots carry pot coins only, and never extract.

**Revenue:** none inside the pit by default (`EXIT_TOLL_BPS=0`); the project lives off the token's trade fee. Set a toll and the UI shows it everywhere it matters.

## Layout — three packages, no workspaces

```
web/        Next 16 + Tailwind 4 + wagmi 3 + canvas 2D — the page, and the shared simulation
  src/shared/   rules · geometry · sim (the pure world) · protocol (JSON + binary snapshot) · names
  src/game/     net.ts (client mirror, interpolation) · render.ts (flies, hatches, pellets, minimap)
  scripts/      sim-test.ts — 57 headless checks of the rules
server/     Node 24 + ws + node:sqlite + viem — the referee
  src/arena.ts  the 20 Hz loop, snapshots, roster, checkpoint
  src/db.ts     the ledger (wei as bigint, whole coins in the arena) and the crash shadow
  src/chain.ts  event watcher (Deposited / Funded / Claimed) + EIP-712 voucher signing
  src/bots.ts   server-played flies
  scripts/      e2e.mts — 27 checks against a running server
contracts/  Hardhat 2 + OZ 5 — Arena.sol (deposit · fund · claim · admin), MockToken for tests
```

The server imports the simulation from `web/src/shared` by relative path; there is one world, not two.

## Run it locally (no chain)

```bash
npm run install:all
```

Terminal 1 — the pit, with test money and short clocks:

```bash
cd server && CHAIN=off DEV_FAUCET=true DEV_AUTH=true TIME_SCALE=0.25 npm run dev
```

Terminal 2 — the page:

```bash
cd web && npm run dev
```

Open the page, connect a wallet (any injected wallet; the signature costs nothing), press **Get 100 test FLYPIT**, stake, fly. `TIME_SCALE=0.25` makes the 60 s stay 15 s and the 8 s hold 2 s; it is refused when `CHAIN=on`.

Without a wallet, `POST /auth/dev {address}` opens a session (only with `DEV_AUTH=true`), and `localStorage.setItem("flypit.session", token)` signs the page in.

## How it looks and moves

The flies are drawn from geometry, no sprite files ([`web/src/game/render.ts`](web/src/game/render.ts)). A fly's trail is one tapered, iridescent tube stroked through its sampled path with round joins, banded like an abdomen, lit from the top-left by a thin specular line, with small wing pairs beating along it and a soft pulse of light sliding down it. Its head is an insect: veined translucent wings drawn at two beat positions so they buzz rather than flicker, a metallic thorax, a striped abdomen, six legs, a head cap with compound eyes and antennae. Everything scales with the coin radius: a whale is the same animal, bigger. Eaten pellets fly into the mouth; deaths burst into coins.

Motion is smooth because the client draws the world a beat and a half (75 ms) behind the server ([`web/src/game/net.ts`](web/src/game/net.ts)): every 20 Hz snapshot is queued as a sample stamped with its tick, a smoothed render clock walks through the queue, and each head is interpolated between the two samples that bracket the clock — there is always a "next" sample to aim at. A late sample is covered by dead-reckoning for up to a tick and a half; a sleeping tab snaps the clock. Bodies are rebuilt from the heads exactly as the server does, one consumed sample at a time, and placed by arc length so they stay glued to a head that is rendered between samples.

## Prove it

```bash
npm test                         # 57 sim checks + the smoothness harness + 14 contract tests
cd server && npm run e2e         # 27 checks against a running local server (see scripts/e2e.mts header)
npm run check                    # eslint + tsc, web and server
npm run build                    # static export of the page
```

What the sim test proves: coins conserved to the unit through 100 s of random play; a cut kills and the killer is credited; head-on kills both; the wall kills; the shield protects and does not eat; pellets are eaten whole; boosting sheds exactly what is lost, behind the head, and is off under the floor; hatches ignore a fly before the minimum stay, fill inside, drain outside, take a bot never, and leave a fly killable; an orphan dies after the grace period; the binary snapshot round-trips; the floor is bounded and merging loses nothing.

What the smoothness harness proves (`web/scripts/smooth-test.ts`): with 20 Hz snapshots jittered by ±14 ms, the rendered head's speed varies by ~3 % frame to frame (the naive lerp-to-latest client, what the first version did, varies by ~97 %: it freezes and leaps), the body never detaches from the head, and the heading follows the server's.

What the e2e proves: sign-in, faucet, refused under-floor stake, spawn, lobby debit, movement from input, death on the wall with the exact drop, a second stake, a hatch held to extraction with the lobby credited by the net, cash-out politely refused without a chain, a dropped socket reattached to the same fly — and the books balanced after every one of those.

## Going live

1. Deploy the Arena for your token:
   ```bash
   cd contracts && cp .env.example .env    # DEPLOYER_PRIVATE_KEY, TOKEN_ADDRESS, SIGNER_ADDRESS
   npm run deploy:robinhood
   ```
   `SIGNER_ADDRESS` is the address of the server's `PAYOUT_SIGNER_KEY` — a hot key, not the owner. The script prints the env lines for both other packages and writes `web/src/lib/abi`.
2. Server: `CHAIN=on ARENA_ADDRESS=… TOKEN_ADDRESS=… PAYOUT_SIGNER_KEY=… START_BLOCK=<deploy block>`; drop `TIME_SCALE`, `DEV_FAUCET`, `DEV_AUTH` (the server refuses to start with them on).
3. Web: `NEXT_PUBLIC_FLYPIT_SERVER=https://<server>` `NEXT_PUBLIC_FLYPIT_ARENA=…` `NEXT_PUBLIC_FLYPIT_TOKEN=…`, then `npm run build` — a static folder.
4. Fund the pot from the token's fee wallet: `Arena.fund(amount)` after an approve.

The name lives in three strings of [`web/src/lib/site.ts`](web/src/lib/site.ts) plus the `NEXT_PUBLIC_FLYPIT_*` prefix and the package names.

## Trust, stated plainly

- **The server is the referee.** A collision at 20 Hz cannot happen on a chain. The chain sees deposits and signed claims; who cut whom is the server's word. Its rules are the shared file above; its books are `/books`.
- **The owner key reaches every token.** `Arena.rescue` moves tokens out; `setSigner` rotates who can sign vouchers. Both are documented in the contract, not hidden. Players should treat the owner key as fully trusted.
- **A crash cannot lose a coin.** Stakes and extractions write a checkpoint row in the same SQLite transaction as the lobby; the checkpoint is refreshed from the live pit every 5 s; on boot, checkpoint coins go back to their owners' lobbies and the floor to the pot, untolled. What a crash can lose is the last few seconds of redistribution.
- **Vouchers are cumulative.** `claim` pays `cumulative − claimed[account]`; a replayed or older voucher pays nothing; a lost voucher is re-signed.
- **Fee-on-transfer safe.** Deposits are credited by the balance difference the contract actually saw.

## Open

- The game has been played end to end with a dev session and with a scripted pilot, never with a real browser wallet: the deposit → event → lobby path is proven by the contract tests and the watcher code, not by a live transaction.
- No rate limit on the HTTP routes beyond the socket's 40 inputs/s; put the server behind a reverse proxy with one.
- Snapshots are per-client binary frames at 20 Hz (~3–6 KB each with a full view); fine for tens of players per server, not hundreds — sharding is a room per server.
- Touch: the pointer steers and a touch boosts; there is no on-screen boost button yet.
- Domain (`flypit.gg` is a placeholder), the X handle, an audit, the signer in a KMS, and whether to turn on a toll.
