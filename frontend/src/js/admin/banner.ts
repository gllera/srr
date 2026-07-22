// The global toast banner: a fixed strip that floats over the page (showing it
// never reflows), auto-hiding 2.5s after a success and staying sticky on an
// error until dismissed. Click-to-dismiss is wired once in bindBanner().

let bannerTimer = 0

function bannerEl(): HTMLElement {
   return document.getElementById("banner")!
}

export function banner(msg: string, ok?: boolean): void {
   const b = bannerEl()
   clearTimeout(bannerTimer) // a prior success timer must not hide this banner
   b.textContent = msg
   b.hidden = false
   b.classList.toggle("ok", !!ok)
   if (ok) bannerTimer = window.setTimeout(() => (b.hidden = true), 2500)
}

export function clearBanner(): void {
   clearTimeout(bannerTimer)
   bannerEl().hidden = true
}

// The banner floats over the page (fixed), so it must always be dismissible
// even when it covers the tab nav.
export function bindBanner(): void {
   bannerEl().addEventListener("click", clearBanner)
}
