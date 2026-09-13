"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GameClient } from "@/game/net";
import { Renderer } from "@/game/render";
import { Hud } from "@/components/Hud";
import { EnterPanel } from "@/components/EnterPanel";
import { HowItWorks } from "@/components/HowItWorks";
import { BankPanel } from "@/components/BankPanel";

export type Overlay = "none" | "how" | "bank";

/**
 * The page. A full-bleed canvas draws the pit; React draws the glass on
 * top and only re-renders when the client says something a panel shows
 * has changed (`subscribe` / `version`), never per frame.
 */
export function Game() {
  const [client] = useState(() => new GameClient());
  const version = useSyncExternalStore(client.subscribe, () => client.version, () => 0);
  const [overlay, setOverlay] = useState<Overlay>("none");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boostKey = useRef(false);

  useEffect(() => {
    client.connect();
    return () => client.dispose();
  }, [client]);

  // Renderer + loop. The backing store is sized from the element's measured
  // box; CSS keeps the element full-screen, so a missed measurement can
  // never widen the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new Renderer(canvas);
    const measure = () => {
      const r = canvas.getBoundingClientRect();
      renderer.resize(r.width || window.innerWidth, r.height || window.innerHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    window.addEventListener("resize", measure);

    let raf = 0;
    let running = true;
    const start = performance.now();
    const frame = () => {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const t = (performance.now() - start) / 1000;
      client.update(t);
      client.flushInput();
      renderer.draw(client, t);
    };
    raf = requestAnimationFrame(frame);
    // Dev hook: draw one frame on demand, for headless captures (the
    // embedded browser pane freezes requestAnimationFrame when hidden).
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __flypitFrame?: (t: number, w?: number, h?: number) => void }).__flypitFrame = (t, w, h) => {
        if (w && h) renderer.resize(w, h);
        client.update(t);
        renderer.draw(client, t);
      };
    }

    // Pointer → heading. The fly flies toward the pointer; holding the
    // button (or Space / Shift) boosts.
    let pointerDown = false;
    const aim = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const dx = ev.clientX - (r.left + r.width / 2);
      const dy = ev.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < 6) return;
      client.setInput(Math.atan2(dy, dx), pointerDown || boostKey.current);
    };
    const down = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest("[data-ui]")) return;
      pointerDown = true;
      aim(ev);
    };
    const up = () => {
      pointerDown = false;
      client.setInput(client.aim, boostKey.current);
    };
    const key = (ev: KeyboardEvent, on: boolean) => {
      if (ev.code === "Space" || ev.key === "Shift") {
        if ((ev.target as HTMLElement).tagName === "INPUT") return;
        boostKey.current = on;
        client.setInput(client.aim, pointerDown || on);
        if (ev.code === "Space") ev.preventDefault();
      }
    };
    const keydown = (ev: KeyboardEvent) => key(ev, true);
    const keyup = (ev: KeyboardEvent) => key(ev, false);
    window.addEventListener("pointermove", aim);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("pointermove", aim);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
    };
  }, [client]);

  const showEnter = client.phase !== "playing" && overlay === "none";

  return (
    <div className="fixed inset-0 select-none" style={{ touchAction: "none" }}>
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-label="The pit" />
      <Hud client={client} version={version} onOpen={setOverlay} />
      {showEnter && <EnterPanel client={client} version={version} onOpen={setOverlay} />}
      {overlay === "how" && <HowItWorks client={client} onClose={() => setOverlay("none")} />}
      {overlay === "bank" && <BankPanel client={client} version={version} onClose={() => setOverlay("none")} />}
    </div>
  );
}
