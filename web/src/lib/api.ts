import { serverUrl } from "@/lib/site";

/**
 * The arena server's JSON routes. Every call returns the parsed body or
 * throws with the server's own sentence, which the UI shows verbatim.
 */

const SESSION_KEY = "flypit.session";

export function getSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string | null): void {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

async function call<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) {
    const s = getSession();
    if (!s) throw new Error("Sign in first.");
    headers.authorization = `Bearer ${s}`;
  }
  let res: Response;
  try {
    res = await fetch(serverUrl() + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  } catch {
    throw new Error("The arena server is not reachable.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body;
}

export interface StatusResponse {
  alive: number;
  bots: number;
  players: number;
  sockets: number;
  floor: number;
  pot: number;
  live: boolean;
  liveNote: string | null;
  token: { symbol: string; decimals: number; address: string | null };
  arena: string | null;
  chainId: number;
  exitTollBps: number;
  recent: { at: number; type: string; name: string | null; coins: number; detail: string | null }[];
}

export const api = {
  status: () => call<StatusResponse>("/status"),
  nonce: (address: string) => call<{ message: string; nonce: string }>("/auth/nonce", { method: "POST", body: JSON.stringify({ address }) }),
  verify: (address: string, nonce: string, message: string, signature: string) =>
    call<{ token: string }>("/auth/verify", { method: "POST", body: JSON.stringify({ address, nonce, message, signature }) }),
  me: () =>
    call<{
      address: string;
      name: string | null;
      lobbyCoins: number;
      lobbyWei: string;
      claimableWei: string;
      claimedWei: string;
      chain: { claimed: string; available: string; paused: boolean; signerMatches: boolean } | null;
      live: boolean;
      liveNote: string | null;
    }>("/me", {}, true),
  cashout: () => call<{ voucher: Voucher; moved: string }>("/cashout", { method: "POST", body: "{}" }, true),
  voucher: () => call<{ voucher: Voucher }>("/voucher", { method: "POST", body: "{}" }, true),
  faucet: (address: string, tokens: string) =>
    call<{ lobbyCoins: number }>("/dev/faucet", { method: "POST", body: JSON.stringify({ address, tokens }) }),
  pot: (tokens: string) => call<{ pot: string }>("/dev/pot", { method: "POST", body: JSON.stringify({ tokens }) }),
};

export interface Voucher {
  account: string;
  cumulative: string;
  deadline: number;
  signature: `0x${string}`;
  arena: string;
  chainId: number;
}
