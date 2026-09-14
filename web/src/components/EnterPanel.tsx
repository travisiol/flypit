"use client";

import { useEffect, useState } from "react";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import type { GameClient } from "@/game/net";
import type { Overlay } from "@/components/Game";
import { Wordmark } from "@/components/Hud";
import { useSignIn } from "@/components/wallet";
import { arenaAbi } from "@/lib/abi";
import { api } from "@/lib/api";
import { robinhoodChain } from "@/lib/chain";
import { tokens } from "@/lib/format";
import { site } from "@/lib/site";
import { RULES, coinsToTokens, tokensToCoins } from "@/shared/rules";
import { shortAddress } from "@/shared/names";

/**
 * The card in the middle of the screen whenever you are not flying:
 * the pitch, the wallet door, the lobby, the deposit, the stake, and the
 * two verdicts (cut / bugged out).
 */
export function EnterPanel({ client, version, onOpen }: { client: GameClient; version: number; onOpen: (o: Overlay) => void }) {
  void version;
  const w = client.welcome;
  const wallet = useSignIn(client);
  const symbol = w?.token.symbol ?? "FLYPIT";
  const [stake, setStake] = useState("10");
  const [name, setName] = useState("");
  const [faucetBusy, setFaucetBusy] = useState(false);

  // Default the stake to what the lobby can afford, once we know it.
  const lobby = client.you?.lobbyCoins ?? 0;
  useEffect(() => {
    if (!client.you) return;
    const t = setTimeout(() => {
      setStake((s) => {
        const cur = tokensToCoins(s) ?? 0;
        if (cur >= RULES.minStakeCoins && cur <= lobby) return s;
        const pick = Math.min(lobby, Math.max(RULES.minStakeCoins, Math.min(RULES.maxStakeCoins, 1000)));
        return coinsToTokens(pick).replace(/,/g, "");
      });
    }, 0);
    return () => clearTimeout(t);
  }, [client.you, lobby]);

  const stakeCoins = tokensToCoins(stake);
  const stakeOk = stakeCoins !== null && stakeCoins >= RULES.minStakeCoins && stakeCoins <= RULES.maxStakeCoins && stakeCoins <= lobby;
  const canPlay = client.phase === "spectating" || client.phase === "dead" || client.phase === "extracted";

  async function faucet() {
    if (!client.you) return;
    setFaucetBusy(true);
    try {
      await api.faucet(client.you.address, "100");
      await api.pot("2000").catch(() => undefined);
    } catch (e) {
      client.setError((e as Error).message);
    } finally {
      setFaucetBusy(false);
    }
  }

  return (
    <div data-ui className="absolute inset-0 z-30 flex items-start justify-center px-3 pb-3 pt-[104px] sm:items-center sm:p-6">
      <div className="glass rise max-h-[calc(100vh-116px)] w-full max-w-[560px] overflow-y-auto p-5 sm:max-h-[92vh] sm:p-7">
        {client.phase === "dead" && client.lastDeath && <Verdict kind="dead" client={client} symbol={symbol} />}
        {client.phase === "extracted" && client.lastExtract && <Verdict kind="out" client={client} symbol={symbol} />}

        {client.phase !== "dead" && client.phase !== "extracted" && (
          <>
            <Wordmark big />
            <p className="mt-3 max-w-[46ch] text-[15px] leading-relaxed text-ink-2">
              A slither pit where the mass is <strong className="text-ink">money</strong>. Stake {symbol}, eat what
              others drop, cut them before they cut you — and to leave, hold a hatch for {w?.timing.extractSeconds ?? RULES.extractSeconds}{" "}
              seconds while everyone can see you doing it.
            </p>
          </>
        )}

        {client.phase === "connecting" && <p className="mt-5 text-sm text-ink-3">Connecting to the pit…</p>}
        {client.phase === "offline" && (
          <div className="mt-5 rounded-xl border border-rim/40 bg-rim/10 px-4 py-3 text-sm">
            The arena server is not answering. It reconnects on its own; the pit you see is the last thing it sent.
          </div>
        )}

        {canPlay && !wallet.signedIn && (
          <div className="mt-6 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-acid" disabled={wallet.busy || !wallet.hasWallet} onClick={wallet.signIn}>
                {wallet.busy ? "Waiting for your wallet…" : "Connect wallet"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => onOpen("how")}>
                How it works
              </button>
            </div>
            {!wallet.hasWallet && (
              <p className="text-sm text-ink-3">No wallet found in this browser. On a phone, open the pit inside your wallet&apos;s browser.</p>
            )}
            {wallet.error && <p className="text-sm text-rim">{wallet.error}</p>}
            <p className="text-[12.5px] text-ink-3">
              Your wallet signs one sentence to prove it is yours — it costs nothing and moves nothing. Without one you can
              watch; the camera follows the biggest fly.
            </p>
          </div>
        )}

        {canPlay && wallet.signedIn && client.you && (
          <div className="mt-6 space-y-5">
            {/* Lobby */}
            <div className="flex items-end justify-between gap-4 rounded-2xl border border-line bg-black/25 px-4 py-3">
              <div>
                <div className="label">{client.practice ? "Practice lobby" : "Your lobby"}</div>
                <div className="num text-2xl font-semibold text-gold">
                  {tokens(lobby)} <span className="text-sm text-ink-3">{symbol}</span>
                </div>
                <div className="mt-0.5 text-[12px] text-ink-3">
                  {client.practice ? "play money · refills after every life" : `${client.you.name ?? shortAddress(client.you.address)} · deposited, not in the pit`}
                </div>
              </div>
              {!client.practice && (
                <div className="flex gap-2">
                  <button type="button" className="btn btn-ghost h-9 px-3 text-[12.5px]" onClick={() => onOpen("bank")}>
                    Bank
                  </button>
                  <button type="button" className="btn btn-ghost h-9 px-3 text-[12.5px]" onClick={wallet.signOut}>
                    Sign out
                  </button>
                </div>
              )}
            </div>

            {client.practice ? (
              <div className="rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3 text-[13px] text-ink-2">
                <div className="mb-1 font-semibold text-gold">Practice pit</div>
                No arena is reachable from this page, so this pit runs in your browser: same rules, same clocks, the same bots —
                on play money. Nothing won or lost here is real. The money game needs the arena server online; the page keeps
                looking for it.
              </div>
            ) : w?.live ? (
              <Deposit client={client} symbol={symbol} />
            ) : (
              <div className="rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3 text-[13px] text-ink-2">
                <div className="mb-1 font-semibold text-gold">No chain behind this pit yet</div>
                {w?.liveNote ?? "Deposits and cash-outs are off."}
                {w?.devFaucet && (
                  <div className="mt-2">
                    <button type="button" className="btn btn-gold h-9 px-4 text-[12.5px]" disabled={faucetBusy} onClick={faucet}>
                      {faucetBusy ? "Pouring…" : `Get 100 test ${symbol}`}
                    </button>
                    <span className="ml-2 text-ink-3">test money, this server only</span>
                  </div>
                )}
              </div>
            )}

            {/* Stake */}
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (stakeOk && stakeCoins !== null) client.spawn(stakeCoins, name.trim() || undefined);
              }}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
                <label className="block">
                  <span className="label">Stake ({symbol})</span>
                  <input
                    className="field num mt-1"
                    inputMode="decimal"
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    placeholder={`${RULES.minStakeCoins / RULES.coinsPerToken}`}
                  />
                </label>
                <label className="block">
                  <span className="label">Name (optional)</span>
                  <input className="field mt-1" value={name} maxLength={14} onChange={(e) => setName(e.target.value)} placeholder="what the feed calls you" />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {[10, 50, 100].map((n) => (
                  <button
                    type="button"
                    key={n}
                    className="pill hover:bg-white/10"
                    onClick={() => setStake(String(Math.min(n, lobby / RULES.coinsPerToken)))}
                  >
                    {n}
                  </button>
                ))}
                <button type="button" className="pill hover:bg-white/10" onClick={() => setStake(coinsToTokens(Math.min(lobby, RULES.maxStakeCoins)).replace(/,/g, ""))}>
                  all
                </button>
                <span className="self-center text-[12px] text-ink-3">
                  {RULES.minStakeCoins / RULES.coinsPerToken} – {(RULES.maxStakeCoins / RULES.coinsPerToken).toLocaleString("en-US")} per life
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" className="btn btn-acid" disabled={!stakeOk}>
                  {client.phase === "dead" || client.phase === "extracted" ? "Enter again" : "Enter the pit"}
                  {stakeOk && stakeCoins !== null && <span className="num opacity-80">· {tokens(stakeCoins)}</span>}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => onOpen("how")}>
                  How it works
                </button>
              </div>
              {client.error && <p className="text-sm text-rim">{client.error}</p>}
              {!stakeOk && lobby < RULES.minStakeCoins && (
                <p className="text-[12.5px] text-ink-3">
                  A life needs at least {RULES.minStakeCoins / RULES.coinsPerToken} {symbol} in the lobby.
                </p>
              )}
              <p className="text-[12px] text-ink-3">
                Everything you stake flies with you. Die and it all hits the floor for whoever eats it. Hatches take you after{" "}
                {w?.timing.minStaySeconds ?? RULES.minStaySeconds}s, and only after {w?.timing.extractSeconds ?? RULES.extractSeconds}s inside one
                {w && w.exitTollBps > 0 ? ` — ${(w.exitTollBps / 100).toFixed(2)} % toll on the way out` : " — no toll"}.
              </p>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function Verdict({ kind, client, symbol }: { kind: "dead" | "out"; client: GameClient; symbol: string }) {
  if (kind === "dead") {
    const d = client.lastDeath!;
    const line =
      d.cause === "wall"
        ? "You hit the wall."
        : d.cause === "timeout"
          ? "Your connection dropped and the pit did not wait."
          : d.cause === "headon"
            ? `Head on with ${d.killerName ?? "someone"}.`
            : `${d.killerName ?? "Someone"} cut you.`;
    return (
      <div className="mb-5 rounded-2xl border border-rim/40 bg-rim/10 px-4 py-4">
        <div className="display text-4xl text-rim">Cut</div>
        <p className="mt-1 text-[15px] text-ink">{line}</p>
        <p className="num mt-1 text-[13px] text-ink-2">
          {tokens(d.coins)} {symbol} hit the floor. Whoever eats it, keeps it.
        </p>
      </div>
    );
  }
  const e = client.lastExtract!;
  return (
    <div className="mb-5 rounded-2xl border border-hatch/40 bg-hatch/10 px-4 py-4">
      <div className="display text-4xl text-hatch">Bugged out</div>
      <p className="num mt-1 text-[15px] text-ink">
        {tokens(e.net)} {symbol} back in your lobby
        {e.toll > 0 ? <span className="text-ink-3"> · toll {tokens(e.toll)}</span> : null}
      </p>
      <p className="mt-1 text-[13px] text-ink-2">Cash it out from the bank, or stake it again.</p>
    </div>
  );
}

/**
 * Approve, then deposit. Credited by the server once the event is a couple
 * of blocks deep — the lobby number on this card updates by itself.
 */
function Deposit({ client, symbol }: { client: GameClient; symbol: string }) {
  const w = client.welcome!;
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [amount, setAmount] = useState("10");
  const [step, setStep] = useState<"idle" | "approving" | "depositing" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const token = (w.token.address ?? site.tokenAddress) as `0x${string}`;
  const arena = (w.arena ?? site.arenaAddress) as `0x${string}`;
  const decimals = w.token.decimals;

  const balance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });
  const allowance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, arena] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  let wei = 0n;
  try {
    wei = parseUnits(amount || "0", decimals);
  } catch {
    wei = 0n;
  }
  const needsApprove = (allowance.data ?? 0n) < wei;
  const enough = (balance.data ?? 0n) >= wei && wei > 0n;

  async function go() {
    setError(null);
    try {
      if (chainId !== robinhoodChain.id) await switchChainAsync({ chainId: robinhoodChain.id });
      if (needsApprove) {
        setStep("approving");
        const h = await writeContractAsync({ address: token, abi: erc20Abi, functionName: "approve", args: [arena, wei] });
        await publicClient?.waitForTransactionReceipt({ hash: h });
        await allowance.refetch();
      }
      setStep("depositing");
      const h2 = await writeContractAsync({ address: arena, abi: arenaAbi, functionName: "deposit", args: [wei] });
      await publicClient?.waitForTransactionReceipt({ hash: h2 });
      setStep("sent");
      await balance.refetch();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setError(/rejected|denied|declined/i.test(text) ? "Your wallet declined." : text.split("\n")[0]);
      setStep("idle");
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-black/25 px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="label">Deposit {symbol}</div>
        <div className="num text-[12px] text-ink-3">
          wallet {balance.data !== undefined ? Number(formatUnits(balance.data, decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "…"}
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <input className="field num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="button" className="btn btn-gold shrink-0" disabled={!enough || step === "approving" || step === "depositing"} onClick={go}>
          {step === "approving" ? "Approving…" : step === "depositing" ? "Depositing…" : needsApprove ? "Approve & deposit" : "Deposit"}
        </button>
      </div>
      {step === "sent" && <p className="mt-2 text-[12.5px] text-hatch">Deposit confirmed. The pit credits it as soon as the block is final — a few seconds.</p>}
      {error && <p className="mt-2 text-[12.5px] text-rim">{error}</p>}
      {!enough && wei > 0n && balance.data !== undefined && <p className="mt-2 text-[12.5px] text-ink-3">Not enough {symbol} in this wallet.</p>}
    </div>
  );
}
