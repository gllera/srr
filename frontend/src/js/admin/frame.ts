// Clickjacking guard for the admin page. It drives a mutating API with the
// operator's session, so it must never run inside another site's frame. A
// reverse proxy can forbid that with CSP frame-ancestors (docs/SELF-HOSTING.md),
// but a <meta> CSP cannot carry that directive and `srr frontend update`
// installs admin.html on any static host — so the page refuses on its own.
// Returns true (and replaces the page) when it is framed.
export function refuseIfFramed(win: Window, body: HTMLElement): boolean {
   let framed: boolean
   try {
      framed = win.top !== win
   } catch {
      framed = true // a cross-origin top that cannot even be compared
   }
   if (framed) body.textContent = "The SRR admin page refuses to run inside a frame. Open it directly."
   return framed
}
