// els.ts — the static DOM reference map: every node index.html declares that the
// app's controllers touch, resolved once at module load.
//
// A LEAF module (no imports), like keys.ts and urlish.ts, for the same reason
// those exist: reader.ts, pin-ui.ts, search-ui.ts and menus.ts all need these
// refs, and reaching back into app.ts for them would point the module graph at
// the orchestrator and break the acyclic property the rest of the frontend is
// built on. Nothing here has behaviour — it is one lookup table, so it is also
// the cheapest possible shared owner.
// One assertion instead of 47. Every entry below is "this selector, cast to
// what index.html declares"; writing that cast per line meant 47 unchecked
// assertions to keep honest, and the plain-HTMLElement majority had to restate
// the type for nothing. The cast still lives here — it just lives ONCE.
const q = <T extends Element = HTMLElement>(sel: string): T => document.querySelector(sel) as T

export const el = {
   article: q(".srr-reader"),
   listView: q(".srr-list"),
   picker: q(".srr-picker"),
   back: q<HTMLButtonElement>(".srr-back"),
   backLabel: q(".srr-back-label"),
   openReader: q<HTMLButtonElement>(".srr-open-reader"),
   title: q(".srr-title"),
   content: q(".srr-content"),
   titleRow: q<HTMLAnchorElement>(".srr-title-row"),
   toolbar: q(".srr-toolbar"),
   prev: q<HTMLButtonElement>(".srr-prev"),
   next: q<HTMLButtonElement>(".srr-next"),
   nextCount: q(".srr-next-count"),
   feed: q<HTMLButtonElement>(".srr-feed"),
   feedName: q(".srr-feed-name"),
   source: q(".srr-source"),
   date: q(".srr-date"),
   desk: q(".srr-desk"),
   searchbar: q(".srr-searchbar"),
   searchInput: q<HTMLInputElement>(".srr-search-input"),
   searchClear: q<HTMLButtonElement>(".srr-search-clear"),
   searchNote: q(".srr-search-note"),
   save: q<HTMLButtonElement>(".srr-save"),
   filter: q<HTMLButtonElement>(".srr-filter"),
   popupText: q(".srr-popup-text"),
   popupRetry: q<HTMLButtonElement>(".srr-popup-retry"),
   popupClose: q(".srr-popup-close"),
   popup: q(".srr-popup"),
   pinProgress: q(".srr-pin-progress"),
   snackbar: q(".srr-snackbar"),
   snackbarText: q(".srr-snackbar-text"),
   snackbarAction: q<HTMLButtonElement>(".srr-snackbar-action"),
   // RDR16 — the mini-player bar. `playerMedia` is the host the live <audio>/
   // <video> is MOVED into when its article stops being rendered, so it is the
   // one ref here that owns a node rather than just reading one.
   player: q(".srr-player"),
   playerMedia: q(".srr-player-media"),
   playerTitle: q<HTMLButtonElement>(".srr-player-title"),
   playerSource: q(".srr-player-source"),
   playerName: q(".srr-player-name"),
   playerSeek: q(".srr-player-seek"),
   playerSeekFill: q(".srr-player-seek-fill"),
   playerToggle: q<HTMLButtonElement>(".srr-player-toggle"),
   playerBack15: q<HTMLButtonElement>(".srr-player-back15"),
   playerFwd15: q<HTMLButtonElement>(".srr-player-fwd15"),
   playerRate: q<HTMLButtonElement>(".srr-player-rate"),
   playerTime: q(".srr-player-time"),
   playerNext: q<HTMLButtonElement>(".srr-player-next"),
   playerQueue: q<HTMLButtonElement>(".srr-player-queue"),
   playerClose: q<HTMLButtonElement>(".srr-player-close"),
}
