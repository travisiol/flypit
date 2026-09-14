"use client";

import { useState } from "react";
import type { GameClient } from "@/game/net";
import { RULES } from "@/shared/rules";
import { site } from "@/lib/site";

type Tab = "rules" | "money" | "hatches" | "faq";

/**
 * The whole explanation, in an overlay that closes back onto the pit.
 * Every number here is read from the shared rules, so the page cannot say
 * one thing while the server does another.
 */
export function HowItWorks({ client, onClose }: { client: GameClient; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("rules");
  const w = client.welcome;
  const symbol = w?.token.symbol ?? "FLYPIT";
  const minStay = w?.timing.minStaySeconds ?? RULES.minStaySeconds;
  const hold = w?.timing.extractSeconds ?? RULES.extractSeconds;
  const shield = w?.timing.spawnShieldSeconds ?? RULES.spawnShieldSeconds;
  const grace = w?.timing.disconnectGraceSeconds ?? RULES.disconnectGraceSeconds;
  const toll = w?.exitTollBps ?? 0;
  const minStake = RULES.minStakeCoins / RULES.coinsPerToken;
  const maxStake = RULES.maxStakeCoins / RULES.coinsPerToken;

  const tabs: { id: Tab; label: string }[] = [
    { id: "rules", label: "The pit" },
    { id: "money", label: "The money" },
    { id: "hatches", label: "Getting out" },
    { id: "faq", label: "Straight answers" },
  ];

  return (
    <div data-ui className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div className="glass rise flex max-h-[92vh] w-full max-w-[720px] flex-col p-5 sm:p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="display text-4xl">How it works</div>
            <p className="mt-1 text-[13px] text-ink-3">{site.tagline}</p>
          </div>
          <button type="button" className="btn btn-ghost h-9 px-3 text-[12.5px]" onClick={onClose}>
            Back to the pit
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-1" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="prose-pit mt-4 overflow-y-auto pr-1 text-[14px]">
          {tab === "rules" && (
            <>
              <h3>Slither, with coins for mass</h3>
              <p>
                You are a fly. You fly toward your pointer at a fixed speed; <strong>hold click or Space to boost</strong> at twice
                the speed. Behind you flies your swarm — your body — and its length is your bankroll: the more {symbol} you
                carry, the longer you are. Long flies turn slower.
              </p>
              <ul>
                <li>
                  <strong>Your head touches any part of another fly — you die.</strong> Head on head, both die. The wall kills.
                </li>
                <li>
                  <strong>Everything you carried drops on the floor</strong> as gold pellets along your body. Anyone can eat it.
                </li>
                <li>
                  Pellets near your head are <strong>pulled into it</strong> — the magnet reaches about three head-widths, and
                  nothing it grabs escapes. Bigger heads pull from further.
                </li>
                <li>
                  Boosting <strong>sheds coins behind you</strong> — {Math.round(RULES.boostShedRate * 4 * 100 * 10) / 10}% of your
                  stack a second, one coin at least. It is the only speed there is, and it costs money. Under{" "}
                  {RULES.boostMinCoins / RULES.coinsPerToken} {symbol} you cannot boost at all.
                </li>
                <li>
                  For {shield}s after you spawn you are <strong>shielded</strong>: you cannot die, kill or eat. You spawn away from the
                  crowd.
                </li>
                <li>
                  Size is not safety. A small fly that cuts in front of a whale kills it, and the whale drops <strong>everything</strong>.
                </li>
              </ul>
              <h3>One life at a time</h3>
              <p>
                One wallet, one fly. A life is between {minStake} and {maxStake.toLocaleString("en-US")} {symbol}. Bots fly too — they
                are the server&apos;s, they only carry coins the pot gave them, and they can never take a coin out.
              </p>
            </>
          )}

          {tab === "money" && (
            <>
              <h3>Where every coin comes from and goes</h3>
              <p>
                The pit runs on one token: <strong>{symbol}</strong>. Inside the arena it is counted in whole coins of{" "}
                {1 / RULES.coinsPerToken} {symbol}. Nothing is ever fractional, nothing is ever rounded away.
              </p>
              <ul>
                <li>
                  <strong>Deposit</strong> into the Arena contract → it lands in your <strong>lobby</strong>, off chain, credited by the
                  exact amount the contract received.
                </li>
                <li>
                  <strong>Stake</strong> from the lobby → your fly spawns carrying it.
                </li>
                <li>
                  <strong>Die</strong> → 100 % of what you carried is on the floor. Not 95. Not &quot;minus a fee&quot;. The pit takes
                  nothing from a death.
                </li>
                <li>
                  <strong>Bug out</strong> through a hatch → what you carry goes back to your lobby
                  {toll > 0 ? ` minus a ${(toll / 100).toFixed(2)} % toll` : ", whole — there is no toll"}.
                </li>
                <li>
                  <strong>Cash out</strong> → the server signs a voucher for your lobby, you claim it from the contract into your wallet.
                </li>
              </ul>
              <h3>The pot</h3>
              <p>
                Anyone can <strong>fund</strong> the Arena. What is funded is the pot: it rains {RULES.rainPelletCoins / RULES.coinsPerToken}{" "}
                {symbol} pellets into the pit and stakes the bots. The pot is the only thing that ever adds coins to the floor;
                without it the pit is exactly zero-sum between players. Nothing funded is owed back to whoever funded it.
              </p>
              <p>
                The one equation the whole thing rests on: every token that ever came in is in a lobby, promised by a voucher, in
                the pot, or inside the arena. The server checks it every few seconds and publishes it at{" "}
                <span className="num">/books</span>.
              </p>
            </>
          )}

          {tab === "hatches" && (
            <>
              <h3>Leaving is the most dangerous thing you do</h3>
              <p>
                A withdraw button would make the game trivial: eat a dead whale, press the button two seconds later. So there is
                no button. There are <strong>{RULES.hatchCount} hatches</strong> on a ring around the arena, and to leave with your
                coins you have to:
              </p>
              <ul>
                <li>
                  have been alive for <strong>{minStay} seconds</strong> — before that, the hatches ignore you;
                </li>
                <li>
                  fly into a hatch and <strong>stay inside for {hold} seconds</strong>. Leave the circle and the meter drains, three
                  times faster than it fills;
                </li>
                <li>
                  survive those {hold} seconds. You are <strong>fully killable</strong> inside a hatch, you cannot boost in it, and the
                  ring shows everyone your colour and your countdown.
                </li>
              </ul>
              <p>
                A fly holding a hatch is a fly that is about to take money off the table, and every other fly can see it. That is
                the design: the exit is a magnet, not a trapdoor.
              </p>
              <h3>Closing the tab is not leaving</h3>
              <p>
                If your socket drops, your fly keeps flying straight for {grace} seconds. Reconnect and it is yours again. Do not,
                and it dies where it is and drops what it carried. A rage-quit is a death, not a withdrawal.
              </p>
            </>
          )}

          {tab === "faq" && (
            <>
              <h3>Who decides that I died?</h3>
              <p>
                The arena server. A collision at twenty ticks a second cannot happen on a chain, so the chain never sees the game
                — it sees deposits going in and signed claims coming out. You are trusting the server to referee honestly, the way
                you trust any real-time game server. The rules it runs are the same file the client and the tests run, and its
                books are public.
              </p>
              <h3>Can the operator take the money?</h3>
              <p>
                Yes, and it is written in the contract rather than hidden: the owner key can rotate the voucher signer and can
                move tokens out with <span className="num">rescue</span>. Whoever holds that key can reach every token in the Arena.
                Treat it as fully trusted or do not deposit.
              </p>
              <h3>What if the server crashes with my fly in the pit?</h3>
              <p>
                Every stake and every extraction is written to a checkpoint in the same transaction as your lobby, and the
                checkpoint is refreshed from the live pit every few seconds. On restart, whatever the checkpoint says you carried
                goes back to your lobby untouched, and the floor goes back to the pot. A restart is not an extraction: no toll,
                no loss. What you can lose is the last few seconds of redistribution — a kill that happened after the last
                checkpoint.
              </p>
              <h3>Can two friends pass coins to each other?</h3>
              <p>
                One can die into the other, yes. It moves coins from one wallet to the other at{" "}
                {toll > 0 ? `the cost of the ${(toll / 100).toFixed(2)} % toll on the way out` : "no cost"} — the same thing a
                transfer does. Nobody else loses anything, and it does not produce a coin that was not already in the pit.
              </p>
              <h3>Why bots?</h3>
              <p>
                So the first person in does not land in an empty pit. They are real flies with real coins — the pot&apos;s coins —
                and they never extract. When the pot is empty they spawn with nothing and are just bodies in the way. They count
                in &quot;flies in the pit&quot;; they never count as players.
              </p>
              <h3>Where is the revenue?</h3>
              <p>
                {toll > 0
                  ? `A ${(toll / 100).toFixed(2)} % toll on what is extracted, paid only by flies that got out. Deposits and deaths cost nothing.`
                  : "Not in the pit: the pit is zero-sum and takes no toll. The project lives off its token's own trade fee, and part of that fee is meant to fund the pot."}
              </p>
              <h3>Is this deployed?</h3>
              <p>
                {w?.live
                  ? `Yes: the Arena contract is on Robinhood Chain and deposits are watched on chain.`
                  : `Not yet. ${w?.liveNote ?? "The arena runs without a chain: deposits and cash-outs are off."} Everything you see is the real engine on test money.`}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
