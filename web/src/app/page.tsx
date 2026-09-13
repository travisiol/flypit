import { Game } from "@/components/Game";

/**
 * One screen. The pit is the page: the arena renders full-bleed behind a
 * glass HUD, and everything else — entering, the bank, the rules — is an
 * overlay that closes back onto it.
 */
export default function Page() {
  return <Game />;
}
