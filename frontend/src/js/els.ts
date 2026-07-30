// els.ts — the static DOM reference map: every node index.html declares that the
// app's controllers touch, resolved once at module load.
//
// A LEAF module (no imports), like keys.ts and urlish.ts, for the same reason
// those exist: reader.ts, pin-ui.ts, search-ui.ts and menus.ts all need these
// refs, and reaching back into app.ts for them would point the module graph at
// the orchestrator and break the acyclic property the rest of the frontend is
// built on. Nothing here has behaviour — it is one lookup table, so it is also
// the cheapest possible shared owner.
export const el = {
   article: document.querySelector(".srr-reader") as HTMLElement,
   listView: document.querySelector(".srr-list") as HTMLElement,
   picker: document.querySelector(".srr-picker") as HTMLElement,
   back: document.querySelector(".srr-back") as HTMLButtonElement,
   backLabel: document.querySelector(".srr-back-label") as HTMLElement,
   openReader: document.querySelector(".srr-open-reader") as HTMLButtonElement,
   title: document.querySelector(".srr-title") as HTMLElement,
   content: document.querySelector(".srr-content") as HTMLElement,
   titleRow: document.querySelector(".srr-title-row") as HTMLAnchorElement,
   toolbar: document.querySelector(".srr-toolbar") as HTMLElement,
   tbPane: document.querySelector(".srr-tb-pane") as HTMLElement,
   tbReader: document.querySelector(".srr-tb-reader") as HTMLElement,
   prev: document.querySelector(".srr-prev") as HTMLButtonElement,
   next: document.querySelector(".srr-next") as HTMLButtonElement,
   nextCount: document.querySelector(".srr-next-count") as HTMLElement,
   feed: document.querySelector(".srr-feed") as HTMLButtonElement,
   feedName: document.querySelector(".srr-feed-name") as HTMLElement,
   source: document.querySelector(".srr-source") as HTMLElement,
   date: document.querySelector(".srr-date") as HTMLElement,
   desk: document.querySelector(".srr-desk") as HTMLElement,
   searchbar: document.querySelector(".srr-searchbar") as HTMLElement,
   searchInput: document.querySelector(".srr-search-input") as HTMLInputElement,
   searchClear: document.querySelector(".srr-search-clear") as HTMLButtonElement,
   searchNote: document.querySelector(".srr-search-note") as HTMLElement,
   save: document.querySelector(".srr-save") as HTMLButtonElement,
   filter: document.querySelector(".srr-filter") as HTMLButtonElement,
   popupText: document.querySelector(".srr-popup-text") as HTMLElement,
   popupRetry: document.querySelector(".srr-popup-retry") as HTMLButtonElement,
   popupClose: document.querySelector(".srr-popup-close") as HTMLElement,
   popup: document.querySelector(".srr-popup") as HTMLElement,
   pinProgress: document.querySelector(".srr-pin-progress") as HTMLElement,
   snackbar: document.querySelector(".srr-snackbar") as HTMLElement,
   snackbarText: document.querySelector(".srr-snackbar-text") as HTMLElement,
   snackbarAction: document.querySelector(".srr-snackbar-action") as HTMLButtonElement,
   // RDR16 — the mini-player bar. `playerMedia` is the host the live <audio>/
   // <video> is MOVED into when its article stops being rendered, so it is the
   // one ref here that owns a node rather than just reading one.
   player: document.querySelector(".srr-player") as HTMLElement,
   playerMedia: document.querySelector(".srr-player-media") as HTMLElement,
   playerTitle: document.querySelector(".srr-player-title") as HTMLButtonElement,
   playerSource: document.querySelector(".srr-player-source") as HTMLElement,
   playerName: document.querySelector(".srr-player-name") as HTMLElement,
   playerSeek: document.querySelector(".srr-player-seek") as HTMLElement,
   playerSeekFill: document.querySelector(".srr-player-seek-fill") as HTMLElement,
   playerToggle: document.querySelector(".srr-player-toggle") as HTMLButtonElement,
   playerBack15: document.querySelector(".srr-player-back15") as HTMLButtonElement,
   playerFwd15: document.querySelector(".srr-player-fwd15") as HTMLButtonElement,
   playerRate: document.querySelector(".srr-player-rate") as HTMLButtonElement,
   playerTime: document.querySelector(".srr-player-time") as HTMLElement,
   playerNext: document.querySelector(".srr-player-next") as HTMLButtonElement,
   playerQueue: document.querySelector(".srr-player-queue") as HTMLButtonElement,
   playerClose: document.querySelector(".srr-player-close") as HTMLButtonElement,
}
