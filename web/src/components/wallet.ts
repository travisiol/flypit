"use client";

import { useCallback, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { api, setSession } from "@/lib/api";
import type { GameClient } from "@/game/net";

/**
 * Connect + sign in, as one gesture. The wallet signs a sentence carrying a
 * nonce, the server answers with a session token, and the socket reconnects
 * with it so the next `welcome` carries the lobby.
 */
export function useSignIn(client: GameClient) {
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const injected = connectors[0];
  const hasWallet = typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;
  const sessionAddress = client.you?.address ?? null;
  const signedIn = !!sessionAddress && (!address || sessionAddress === address.toLowerCase());

  const signIn = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      let addr = address;
      if (!isConnected || !addr) {
        if (!injected) throw new Error("No wallet found in this browser.");
        const r = await connectAsync({ connector: injected });
        addr = r.accounts[0];
      }
      if (!addr) throw new Error("No wallet found in this browser.");
      const { message, nonce } = await api.nonce(addr);
      const signature = await signMessageAsync({ message });
      const v = await api.verify(addr, nonce, message, signature);
      setSession(v.token);
      client.reconnect();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (/rejected|denied|declined|cancel/i.test(text)) setError("Your wallet declined. Nothing was signed and nothing has changed.");
      else if (/No wallet/i.test(text)) setError("No wallet found in this browser. On a phone, open the pit inside your wallet's browser.");
      else setError(text.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }, [address, isConnected, injected, connectAsync, signMessageAsync, client]);

  const signOut = useCallback(async () => {
    setSession(null);
    try {
      await disconnectAsync();
    } catch {
      /* nothing to disconnect */
    }
    client.reconnect();
  }, [disconnectAsync, client]);

  return { address, isConnected, hasWallet, signedIn, sessionAddress, busy, error, signIn, signOut };
}
