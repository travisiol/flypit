"use client";

import { useEffect, useState } from "react";
import type { GameClient } from "@/game/net";
import type { Overlay } from "@/components/Game";
import { FLAG_BOOST, FLAG_HATCHES_OPEN, FLAG_IN_HATCH, FLAG_SHIELD } from "@/shared/protocol";
import { RULES } from "@/shared/rules";
import { site } from "@/lib/site";
import { compact, seconds, tokens } from "@/lib/format";
import { shortAddress } from "@/shared/names";

/**
 * The glass over the pit. Live numbers that change every frame (my coins,
 * the hatch clock) are sampled four times a second; everything else
 * re-renders only when the client bumps its version.
 */
export function Hud({ client, version, onOpen }: { client: GameClient; version: number; onOpen: (o: Overlay) => void }) {
  void version;
  const [live, setLive] = useState<{ coins: number; flags: number; extract: number; stay: number; ping: number } | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const me = client.me();
      setLive(me ? { coins: me.coins, flags: me.flags, extract: me.extract, stay: client.stayLeft(), ping: client.ping } : null);
    }, 250);
    return () => clearInterval(id);
  }, [client]);

  const w = client.welcome;
  const board = client.board;
  const symbol = w?.token.symbol ?? site.ticker.replace("$", "");
  const playing = client.phase === "playing";
  const signedIn = !!client.you;

  return (
    <>
      {/* Top bar */}
      <div data-ui className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-3 sm:p-4">
        <div className="flex flex-col gap-2">
          <div className="glass-soft pointer-events-auto flex items-center gap-3 px-3 py-2">
            <Wordmark />
            <span className="hidden h-4 w-px bg-white/10 sm:block" />
            <span className="pill">
              <i className="dot" style={{ background: client.practice ? "#ffd166" : w ? (w.live ? "#c8ff3d" : "#ffd166") : "#6b7285" }} />
              {client.practice
                ? "practice pit · play money"
                : client.phase === "offline" || client.phase === "connecting"
                  ? client.phase === "offline"
                    ? "server offline"
                    : "connecting…"
                  : w?.live
                    ? "live on Robinhood Chain"
                    : "no chain yet"}
            </span>
          </div>
          <div className="pointer-events-auto flex flex-wrap gap-2">
            <span className="pill">
              <span className="num text-ink">{board?.alive ?? 0}</span> flies in the pit
            </span>
            <span className="pill">
              <span className="num text-gold">{tokens(board?.floor ?? 0, 0)}</span> {symbol} on the floor
            </span>
            <span className="pill">
              <span className="num text-hatch">{tokens(board?.pot ?? 0, 0)}</span> {symbol} in the pot
            </span>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          {live && <span className="pill num hidden sm:inline-flex">{live.ping} ms</span>}
          <button type="button" className="btn btn-ghost h-9 px-3 text-[13px] sm:px-4" onClick={() => onOpen("how")} aria-label="How it works">
            <span className="sm:hidden">?</span>
            <span className="hidden sm:inline">How it works</span>
          </button>
          {signedIn && !client.practice && (
            <button type="button" className="btn btn-ghost h-9 px-3 text-[13px] sm:px-4" onClick={() => onOpen("bank")}>
              Bank
              {client.you && client.you.lobbyCoins > 0 && (
                <span className="num hidden text-gold sm:inline">{tokens(client.you.lobbyCoins)}</span>
              )}
            </button>
          )}
          {client.you && !client.practice && (
            <span className="pill hidden sm:inline-flex">
              <i className="dot bg-acid" />
              {client.you.name ?? shortAddress(client.you.address)}
            </span>
          )}
        </div>
      </div>

      {/* Leaderboard */}
      {board && board.top.length > 0 && (
        <div data-ui className="pointer-events-none absolute left-3 top-[104px] z-10 hidden w-56 sm:block sm:left-4">
          <div className="glass-soft px-3 py-2">
            <div className="label mb-1">Biggest in the pit</div>
            <ol className="space-y-[3px]">
              {board.top.map((row, i) => (
                <li key={row.id} className="flex items-center gap-2 text-[12.5px]">
                  <span className="num w-4 text-ink-3">{i + 1}</span>
                  <span className={`flex-1 truncate ${row.id === client.myId ? "text-acid" : "text-ink-2"}`}>{row.name}</span>
                  <span className="num text-gold">{tokens(row.coins, 0)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {/* Feed */}
      {client.feed.length > 0 && (
        <div data-ui className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[320px] flex-col gap-1 sm:bottom-4 sm:left-4">
          {client.feed.map((f) => (
            <div key={f.id} className="rise glass-soft px-3 py-1.5 text-[12px] text-ink-2">
              <span className={f.kind === "extract" ? "text-hatch" : f.kind === "cut" || f.kind === "headon" ? "text-rim" : "text-ink-3"}>
                {f.kind === "extract" ? "▲" : "✕"}
              </span>{" "}
              {f.text}
            </div>
          ))}
        </div>
      )}

      {/* My status */}
      {playing && live && (
        <div data-ui className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center sm:bottom-5">
          <div className="glass flex w-[min(92vw,520px)] flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="label">Carrying</div>
                <div className="num text-2xl font-semibold text-gold">
                  {tokens(live.coins)} <span className="text-sm text-ink-3">{symbol}</span>
                </div>
              </div>
              <div className="text-right">
                {live.flags & FLAG_IN_HATCH && live.flags & FLAG_HATCHES_OPEN ? (
                  <>
                    <div className="label text-hatch">Bugging out — stay inside</div>
                    <div className="num text-2xl font-semibold text-hatch">
                      {seconds((1 - live.extract) * (w?.timing.extractSeconds ?? RULES.extractSeconds))}
                    </div>
                  </>
                ) : live.flags & FLAG_HATCHES_OPEN ? (
                  <>
                    <div className="label">Hatches</div>
                    <div className="text-sm font-semibold text-hatch">open · hold one {w?.timing.extractSeconds ?? RULES.extractSeconds}s</div>
                  </>
                ) : (
                  <>
                    <div className="label">Hatches open in</div>
                    <div className="num text-2xl font-semibold text-ink">{seconds(live.stay)}</div>
                  </>
                )}
              </div>
            </div>
            {live.flags & FLAG_IN_HATCH && live.flags & FLAG_HATCHES_OPEN ? (
              <div className="meter">
                <i style={{ width: `${Math.round(live.extract * 100)}%` }} />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
              {live.flags & FLAG_SHIELD ? <span className="text-ink">shielded</span> : null}
              {live.flags & FLAG_BOOST ? <span className="text-acid">boosting · shedding coins</span> : null}
              <span>
                <span className="kbd">hold click</span> or <span className="kbd">space</span> to boost
              </span>
              <span>{compact(live.coins)} coins</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function Wordmark({ big = false }: { big?: boolean }) {
  return (
    <span className={`display inline-flex items-center gap-1.5 ${big ? "text-[clamp(56px,11vw,120px)]" : "text-[17px]"}`}>
      <FlyMark size={big ? 0.9 : 0.22} />
      {site.wordmark}
    </span>
  );
}

/** The mark: a fly seen from above, drawn from the same shapes the arena uses. */
export function FlyMark({ size = 1 }: { size?: number }) {
  const px = Math.round(64 * size);
  return (
    <svg width={px} height={px} viewBox="0 0 64 64" aria-hidden="true">
      <ellipse cx="22" cy="30" rx="16" ry="6" transform="rotate(-28 22 30)" fill="#dbe9ff" opacity=".35" />
      <ellipse cx="42" cy="30" rx="16" ry="6" transform="rotate(28 42 30)" fill="#dbe9ff" opacity=".35" />
      <ellipse cx="32" cy="36" rx="12" ry="9" fill="#c8ff3d" />
      <rect x="26" y="29" width="3" height="14" fill="#2b4400" opacity=".6" />
      <rect x="20" y="31" width="3" height="10" fill="#2b4400" opacity=".6" />
      <circle cx="39" cy="32" r="4" fill="#ff2d55" />
      <circle cx="39" cy="40" r="4" fill="#ff2d55" />
      <circle cx="40" cy="31" r="1.2" fill="#fff" />
      <circle cx="40" cy="39" r="1.2" fill="#fff" />
    </svg>
  );
}
