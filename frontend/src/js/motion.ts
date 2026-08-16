// motion.ts — the two motion idioms every surface pulses chrome with, stated
// once. A LEAF module (imports nothing), like els.ts/urlish.ts.

// Restart `cls`'s CSS keyframes on `el` even mid-run: remove + re-add in one
// task is a no-op without the forced reflow between them. When `ms` is given the
// class comes off after the animation ends (pass a value ABOVE the animation's
// duration) so the next add restarts it naturally; without it the caller relies
// on the next restartAnimation call's remove.
export function restartAnimation(el: HTMLElement, cls: string, ms?: number): void {
   el.classList.remove(cls)
   void el.offsetWidth
   el.classList.add(cls)
   if (ms) setTimeout(() => el.classList.remove(cls), ms)
}

// The reduced-motion probe, feature-detected for engines without matchMedia
// (jsdom). CSS handles most reduced-motion flattening; this is for the few
// behaviors only script can reach (a smooth-vs-instant scroll, a settle skip).
export function prefersReducedMotion(): boolean {
   return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}
