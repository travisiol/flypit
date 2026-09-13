"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import type { GameClient } from "@/game/net";
import { arenaAbi } from "@/lib/abi";
import { api, type Voucher } from "@/lib/api";
import { explorer, robinhoodChain } from "@/lib/chain";
import { weiToTokens } from "@/lib/format";
import { site } from "@/lib/site";

type Me = Awaited<ReturnType<typeof api.me>>;

/**
 * Two explicit steps, because they are two different things:
 *   1. "Cash out" — the server moves your lobby into a signed voucher
 *      (a running total it will honour);
 *   2. "Claim" — you send that voucher to the Arena contract yourself and
 *      the token lands in your wallet.
 * A voucher is never lost: ask again and the server re-signs the same total.
 */
export function BankPanel({ client, version, onClose }: { client: GameClient; version: number; onClose: () => void }) {
  void version;
  const w = client.welcome;
  const symbol = w?.token.symbol ?? "FLYPIT";
  const decimals = w?.token.decimals ?? 18;
  const [me, setMe] = useState<Me | null>(null);
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [busy, setBusy] = useState<"" | "cashout" | "voucher" | "claim">("");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  async function refresh() {
    try {
      setMe(await api.me());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [client.you?.lobbyWei]);

  const lobbyWei = BigInt(me?.lobbyWei ?? client.you?.lobbyWei ?? "0");
  const claimable = BigInt(me?.claimableWei ?? "0");
  const claimedOnChain = BigInt(me?.chain?.claimed ?? me?.claimedWei ?? "0");
  const pending = claimable > claimedOnChain ? claimable - claimedOnChain : 0n;

  async function cashOut() {
    setBusy("cashout");
    setError(null);
    try {
      const r = await api.cashout();
      setVoucher(r.voucher);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function getVoucher() {
    setBusy("voucher");
    setError(null);
    try {
      const r = await api.voucher();
      setVoucher(r.voucher);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function claim() {
    if (!voucher) return;
    setBusy("claim");
    setError(null);
    try {
      if (chainId !== robinhoodChain.id) await switchChainAsync({ chainId: robinhoodChain.id });
      const hash = await writeContractAsync({
        address: voucher.arena as `0x${string}`,
        abi: arenaAbi,
        functionName: "claim",
        args: [BigInt(voucher.cumulative), BigInt(voucher.deadline), voucher.signature],
      });
      setTxHash(hash);
      await publicClient?.waitForTransactionReceipt({ hash });
      setVoucher(null);
      await refresh();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setError(/rejected|denied|declined/i.test(text) ? "Your wallet declined." : text.split("\n")[0]);
    } finally {
      setBusy("");
    }
  }

  return (
    <div data-ui className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div className="glass rise w-full max-w-[520px] p-5 sm:p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <div className="display text-4xl">Bank</div>
            <p className="mt-1 text-[13px] text-ink-3">Lobby → voucher → your wallet. Two steps, each one yours.</p>
          </div>
          <button type="button" className="btn btn-ghost h-9 px-3 text-[12.5px]" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-line bg-black/25 px-4 py-3">
            <div className="label">Lobby</div>
            <div className="num text-xl font-semibold text-gold">{weiToTokens(lobbyWei, decimals)}</div>
            <div className="text-[11.5px] text-ink-3">{symbol} · stake it or cash it out</div>
          </div>
          <div className="rounded-2xl border border-line bg-black/25 px-4 py-3">
            <div className="label">Cashed out, unclaimed</div>
            <div className="num text-xl font-semibold text-hatch">{weiToTokens(pending, decimals)}</div>
            <div className="text-[11.5px] text-ink-3">{symbol} · waiting for your claim</div>
          </div>
        </div>

        {!w?.live && (
          <div className="mt-4 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3 text-[13px] text-ink-2">
            <span className="font-semibold text-gold">Cash-outs are off:</span> {w?.liveNote ?? "no chain behind this pit yet."} Your lobby
            still counts and still stakes.
          </div>
        )}

        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-gold" disabled={!w?.live || lobbyWei <= 0n || busy !== ""} onClick={cashOut}>
              {busy === "cashout" ? "Signing…" : `1 · Cash out ${weiToTokens(lobbyWei, decimals)} ${symbol}`}
            </button>
            {pending > 0n && !voucher && (
              <button type="button" className="btn btn-ghost" disabled={busy !== ""} onClick={getVoucher}>
                {busy === "voucher" ? "Signing…" : "Get my voucher again"}
              </button>
            )}
          </div>
          {voucher && (
            <div className="rounded-2xl border border-hatch/40 bg-hatch/10 px-4 py-3">
              <div className="text-[13px] text-ink">
                Voucher signed for a running total of <span className="num text-hatch">{weiToTokens(voucher.cumulative, decimals)}</span> {symbol}
                {pending > 0n && (
                  <>
                    {" "}
                    — <span className="num">{weiToTokens(pending, decimals)}</span> of it is new.
                  </>
                )}
              </div>
              <div className="mt-1 text-[11.5px] text-ink-3">
                Valid until {new Date(voucher.deadline * 1000).toLocaleTimeString()}. Sending it twice pays nothing twice.
              </div>
              <button type="button" className="btn btn-acid mt-3" disabled={busy !== "" || pending <= 0n} onClick={claim}>
                {busy === "claim" ? "Confirm in your wallet…" : "2 · Claim on chain"}
              </button>
            </div>
          )}
          {txHash && (
            <p className="text-[12.5px] text-ink-2">
              Claimed —{" "}
              <a className="text-hatch underline" href={explorer.tx(txHash)} target="_blank" rel="noreferrer">
                see the transaction
              </a>
              .
            </p>
          )}
          {error && <p className="text-[13px] text-rim">{error}</p>}
          {me?.chain && !me.chain.signerMatches && (
            <p className="text-[12.5px] text-rim">
              The contract&apos;s signer does not match this server&apos;s key: vouchers from here would be refused. The operator has to
              rotate it.
            </p>
          )}
        </div>

        <div className="mt-5 text-[11.5px] leading-relaxed text-ink-3">
          The voucher is an EIP-712 signature over your wallet, a cumulative total and a deadline. The Arena contract pays the
          difference between that total and what it already paid you, so an old voucher is harmless and a lost one is replaced.
          {w?.arena && (
            <>
              {" "}
              Contract{" "}
              <a className="num underline" href={explorer.address(w.arena)} target="_blank" rel="noreferrer">
                {w.arena.slice(0, 10)}…
              </a>
              {" · "}
              <span className="num">{site.ticker}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
