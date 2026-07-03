"use strict";

// --- tiny fetch helpers -----------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}
const apiGet = (p) => api("GET", p);

// streamSSE POSTs to path and invokes onEvent({event, data}) for each SSE
// frame; an optional AbortSignal cancels the stream (and, server-side, the
// fetch cycle it drives — the handler runs under the request context).
async function streamSSE(path, onEvent, signal) {
  const res = await fetch(path, { method: "POST", signal });
  if (!res.ok) throw new Error(res.statusText);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = "message", data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
        }
        onEvent({ event: ev, data: data ? JSON.parse(data) : null });
      }
    }
  } finally {
    reader.cancel();
  }
}

let bannerTimer = 0;
function banner(msg, ok) {
  const b = document.getElementById("banner");
  clearTimeout(bannerTimer); // a prior success timer must not hide this banner
  b.textContent = msg;
  b.hidden = false;
  b.classList.toggle("ok", !!ok);
  if (ok) bannerTimer = setTimeout(() => (b.hidden = true), 2500);
}
function clearBanner() {
  clearTimeout(bannerTimer);
  document.getElementById("banner").hidden = true;
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== "") e.append(kid); // "" = no child — keeps :empty selectors honest
  return e;
}

// Inline monochrome icons (Feather-style, currentColor) shared by the row-action
// buttons (edit / delete) across every tab.
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_DELETE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
const ICON_FETCH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const ICON_PREVIEW =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

// Source-color slot for a feed id — mirrors the reader's fmt.srcColorIndex so a
// feed's rail color in the console matches the color it carries in the reader.
const SRC_COLORS = 8;
const srcColorIndex = (id) => ((id % SRC_COLORS) + SRC_COLORS) % SRC_COLORS;

// relTime renders a unix-seconds timestamp as a coarse "how long ago" readout
// ("3h ago"); 0 = "never". Coarse on purpose — exact instants ride titles.
function relTime(sec) {
  if (!sec) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return Math.floor(s / 604800) + "w ago";
}

// pipeTokens renders a recipe's pipe steps as connected wire tokens (mono chips
// joined by → arrows); a built-in #mod gets the signal tint. Empty pipe → em dash.
function pipeTokens(pipe) {
  const steps = pipe || [];
  if (!steps.length) return el("span", { class: "muted" }, "—");
  const kids = [];
  steps.forEach((s, i) => {
    if (i) kids.push(el("span", { class: "arrow" }, "→"));
    kids.push(el("span", { class: "tok" + (s.startsWith("#") ? " builtin" : "") }, s));
  });
  return el("div", { class: "pipe" }, ...kids);
}

// emptyState is the shared directed empty panel — a wire eyebrow over a one-line
// invitation, matching the reader's empty-state voice.
function emptyState(eyebrow, msg) {
  return el("div", { class: "empty" },
    el("div", { class: "empty-eyebrow" }, eyebrow),
    el("div", { class: "empty-msg" }, msg));
}

// confirmDelete is the shared confirm → DELETE → banner → refresh flow used by
// every tab's delete action; refresh() re-pulls the snapshot after the delete.
async function confirmDelete(question, url, successMsg) {
  if (!confirm(question)) return false;
  try {
    await api("DELETE", url);
    banner(successMsg, true);
    await refresh();
    return true;
  } catch (e) {
    banner(e.message);
    return false;
  }
}

// saveModal is the shared try/refresh/close/banner/catch boilerplate for every
// modal save button. Validation and request-body building stay in the caller.
async function saveModal(dlg, errBox, doApi, okMsg) {
  try { await doApi(); await refresh(); dlg.close(); banner(okMsg, true); }
  catch (e) { errBox.textContent = e.message; }
}

// appendRecipeOptions fills a <select> with recipe-name options from the given
// recipes map (skipping the implicit "default"), marking `selected` chosen.
function appendRecipeOptions(sel, selected, recipes) {
  for (const n of Object.keys(recipes).sort()) {
    if (n === "default") continue;
    const o = el("option", { value: n }, n);
    if (n === selected) o.selected = true;
    sel.append(o);
  }
}

// dialogRow is the shared Cancel + Save footer row every modal ends with.
// dialogRow builds the modal footer: Cancel + Save on the right, plus — when an
// onDelete is given (edit of an existing, deletable item) — a Delete button on
// the left. onDelete resolves truthy on a confirmed delete, then the dialog closes.
function dialogRow(dlg, saveBtn, onDelete) {
  const kids = [];
  if (onDelete) {
    kids.push(el("button", {
      class: "btn danger", style: "margin-right:auto",
      onclick: async () => { if (await onDelete()) dlg.close(); },
    }, "Delete"));
  }
  kids.push(el("button", { class: "btn", onclick: () => dlg.close() }, "Cancel"), saveBtn);
  return el("div", { class: "row" }, ...kids);
}

// --- store snapshot + tab router --------------------------------------------
// The whole store (GET /api/overview) is fetched once into `snapshot`; every tab
// renders from it, so switching tabs never hits the store. The store is re-read
// only on boot (a browser reload re-runs it) and after a mutation, via refresh().
const renderers = {}; // tab name -> sync render fn, drawing from `snapshot`
let snapshot = { feeds: [], tags: [], recipes: {}, out: [], gen: 0, total_art: 0, fetched_at: 0 };
let currentTab = "feeds";

// drawTab (re)renders the current tab from the cached snapshot — no fetch.
function drawTab() {
  const r = renderers[currentTab];
  if (r) {
    try { r(); } catch (e) { banner(e.message); }
  }
}

function showTab(name) {
  currentTab = name;
  history.replaceState(null, "", "#" + name); // deep-linkable; survives the reload-to-refresh model
  for (const b of document.querySelectorAll("#tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  for (const s of document.querySelectorAll(".tab"))
    s.classList.toggle("active", s.id === name);
  clearBanner();
  drawTab();
}

// loadSnapshot re-pulls the whole-store snapshot without redrawing; snapshotAt
// drives the focus-refresh throttle below.
let snapshotAt = 0;
async function loadSnapshot() {
  snapshot = await apiGet("/api/overview");
  snapshotAt = Date.now();
}

// refresh re-pulls the snapshot and redraws the current tab. It deliberately
// does NOT clear the banner, so a caller can set a success message and then
// refresh the data under it.
async function refresh() {
  await loadSnapshot();
  drawTab();
}

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));

// Same-document hash navigation (a bookmark or hand-edited #tab on an open
// page) switches tabs too; boot handles the initial hash.
window.addEventListener("hashchange", () => {
  const want = location.hash.slice(1);
  if (renderers[want] && want !== currentTab) showTab(want);
});

// A hidden tab drifts while the background --interval loop (or a cron fetch)
// writes the store, so a stale-enough snapshot is re-pulled when the operator
// comes back. Tools is not redrawn in place — that would wipe its streamed
// fetch/inspect logs; it re-reads the snapshot on its next render anyway.
const FOCUS_REFRESH_MS = 30000;
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - snapshotAt < FOCUS_REFRESH_MS) return;
  if (document.body.classList.contains("fetching")) return;
  try {
    await loadSnapshot();
    if (currentTab !== "tools") drawTab();
  } catch {
    // transient — the next focus (or any mutation) retries
  }
});

// --- feeds tab --------------------------------------------------------------
const feedsState = { search: "", tag: "", grade: "", sort: "title", dir: 1 };
const UNTAGGED = "\x00"; // sentinel: the "(untagged)" filter option value, distinct from "" (= all tags)

// A feed that fetches fine but has produced nothing new for this long is a
// zombie candidate — the publisher stopped, moved, or broke silently.
const STALE_AFTER = 30 * 86400;

// Store-pulse thresholds: how old the store-wide fetched_at may get before the
// console raises the alarm. The fetch loop normally cycles every few minutes,
// so hours of silence mean the loop itself is down — the one failure the
// per-feed grades can't see.
const PULSE_AMBER_S = 6 * 3600;
const PULSE_RED_S = 24 * 3600;

// storePulse grades the store's own heartbeat (ok / amber / red) from the age
// of the last committed fetch. A never-fetched store with feeds is red (the
// loop has never run); an empty store is silent — nothing to fetch yet.
function storePulse() {
  if (!snapshot.fetched_at) return snapshot.feeds.length ? "red" : "ok";
  const age = Date.now() / 1000 - snapshot.fetched_at;
  return age >= PULSE_RED_S ? "red" : age >= PULSE_AMBER_S ? "amber" : "ok";
}

// feedGrade buckets a feed's health: ok (live) / warn (failing, recoverable) /
// err (fault, streak >= 3) / stale (fetching fine, no new article in 30d) /
// idle (never fetched). The dot + board share it. last_new === 0 with a
// healthy fetch stays ok: pre-vitals stores never stamped it, and a false
// "stale" on every migrated feed would drown the real zombies.
function feedGrade(f) {
  if (f.error) return f.fail_streak >= 3 ? "err" : "warn";
  if (!f.last_ok) return "idle";
  if (f.last_new && Date.now() / 1000 - f.last_new > STALE_AFTER) return "stale";
  return "ok";
}
const GRADE_DOT = { ok: "green", warn: "amber", err: "red", stale: "dim", idle: "gray" };

// healthDot is the small status dot. Its native title carries the health detail
// (last fetch / last new article). For a failing feed the error rides a richer
// hover/focus tooltip instead (see feedRow).
function healthDot(f) {
  const title = f.last_ok
    ? `last fetch ${relTime(f.last_ok)} · last new article ${relTime(f.last_new)}`
    : "never fetched";
  return el("span", { class: "dot " + GRADE_DOT[feedGrade(f)], title });
}

// healthBoard is the Feeds-tab hero: a one-line readout of the whole wire's
// health (total sources, then each non-empty grade with its count), plus the
// store meta (articles, last fetch). Each grade stat is a filter toggle; the
// total resets it.
function healthBoard() {
  const c = { ok: 0, warn: 0, err: 0, stale: 0, idle: 0 };
  for (const f of snapshot.feeds) c[feedGrade(f)]++;
  const total = snapshot.feeds.length;
  // Grade filters redraw board + table in place (not drawFeeds) so the search
  // input keeps its focus and value while the operator composes filters.
  const setGrade = (g) => { feedsState.grade = g; drawBoard(); drawTable(); };
  const board = el("div", { class: "board" },
    el("button", {
      class: "total", title: "show all feeds",
      onclick: () => setGrade(""),
    }, el("b", {}, String(total)), total === 1 ? " source" : " sources"));
  const add = (grade, n, dot, label) => {
    if (!n) return;
    const active = feedsState.grade === grade;
    board.append(el("button", {
      class: "stat" + (active ? " active" : ""),
      title: active ? "clear the filter" : "show only " + label + " feeds",
      onclick: () => setGrade(active ? "" : grade),
    }, el("i", { class: "dot " + dot }), el("b", {}, String(n)), " " + label));
  };
  add("ok", c.ok, "green", "live");
  add("warn", c.warn, "amber", "warn");
  add("err", c.err, "red", "fault");
  add("stale", c.stale, "dim", "stale");
  add("idle", c.idle, "gray", "idle");
  board.append(el("span", { class: "meta" },
    `${snapshot.total_art.toLocaleString()} articles · `,
    el("span", { class: "pulse", "data-grade": storePulse() },
      `fetched ${relTime(snapshot.fetched_at)}`)));
  return board;
}

// pulseStrip is the store-level alarm: when the whole store hasn't fetched in
// hours (see storePulse) a full-width strip surfaces the silence — with the
// remedy inline — instead of leaving it to the board's quiet meta readout.
// Returns null while the pulse is healthy.
function pulseStrip() {
  const grade = storePulse();
  if (grade === "ok") return null;
  const btn = el("button", {
    class: "btn",
    disabled: document.body.classList.contains("fetching") ? "" : null,
    onclick: (e) => fetchAllFromStrip(e.currentTarget),
  }, "Fetch now");
  return el("div", { class: "pulse-alert", "data-grade": grade, role: "alert" },
    el("span", { class: "pulse-msg" },
      snapshot.fetched_at
        ? `last fetch ${relTime(snapshot.fetched_at)} — fetch loop may be down`
        : "store never fetched — fetch loop may be down"),
    btn);
}

// drawBoard fills the stable #feedsBoard container with [pulse alarm?, health
// board] — the in-place redraw target for grade-filter clicks and live fetch
// events, kept apart from the toolbar so redraws never touch the search input.
function drawBoard() {
  const box = document.getElementById("feedsBoard");
  if (!box) return;
  const strip = pulseStrip();
  box.replaceChildren(...(strip ? [strip] : []), healthBoard());
}

function feedMatches(f) {
  if (feedsState.grade && feedGrade(f) !== feedsState.grade) return false;
  if (feedsState.tag) {
    const want = feedsState.tag === UNTAGGED ? "" : feedsState.tag;
    if ((f.tag || "") !== want) return false;
  }
  if (feedsState.search) {
    const q = feedsState.search.toLowerCase();
    if (!(f.title + " " + f.url).toLowerCase().includes(q)) return false;
  }
  return true;
}

renderers.feeds = drawFeeds;

function drawFeeds() {
  const root = document.getElementById("feeds");
  root.replaceChildren();

  const search = el("input", {
    type: "search", placeholder: "search title/url", value: feedsState.search,
    oninput: (e) => { feedsState.search = e.target.value; drawTable(); },
  });
  const tagSel = el("select", {
    onchange: (e) => { feedsState.tag = e.target.value; drawTable(); },
  }, el("option", { value: "" }, "all tags"));
  for (const t of snapshot.tags) {
    const optVal = t.tag === "" ? UNTAGGED : t.tag;
    const label = (t.tag || "(untagged)") + ` — ${t.feeds}`;
    const o = el("option", { value: optVal }, label);
    if (optVal === feedsState.tag) o.selected = true;
    tagSel.append(o);
  }
  const add = el("button", { class: "btn primary", onclick: () => openFeedModal(null) }, "+ Add feed");

  const exportBtn = el("button", { class: "btn", onclick: () => { window.location = "/api/export"; } }, "Export OPML");
  // Import is a two-step flow: a dry run first (resolution probes every URL, so
  // this can take a moment), then a confirm dialog showing what will import and
  // what gets skipped — import is partial-success, the skip report matters.
  const importInput = el("input", { type: "file", accept: ".opml,.xml,text/xml", style: "display:none",
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      banner("Resolving OPML feeds…", true);
      try {
        const text = await file.text();
        const dry = await importReq(text, true);
        clearBanner();
        openImportModal(dry, text);
      } catch (err) { banner(err.message); }
    } });
  const importBtn = el("button", { class: "btn", onclick: () => importInput.click() }, "Import OPML");
  root.append(el("div", { id: "feedsBoard" }));
  root.append(el("div", { class: "toolbar" }, search, tagSel, add, importBtn, importInput, exportBtn));
  root.append(el("div", { id: "feedTableWrap" }));
  drawBoard();
  drawTable();
}

// feedRow builds one Feeds-table row. A healthy feed shows a plain status dot; a
// failing feed wraps its dot in a focusable trigger that reveals the last fetch
// error as a hover/focus tooltip (the styled wire-log bubble; the wrapper's
// aria-label carries the same text for screen readers) AND carries the same
// error inline under its title — triage must not require hovering each dot.
function feedRow(f) {
  let statusCell;
  if (f.error) {
    const tip = el("span", { class: "tip", "aria-hidden": "true" },
      el("span", { class: "streak" }, `fail ×${f.fail_streak}`),
      el("span", { class: "msg" }, f.error));
    const wrap = el("span", {
      class: "dotwrap", tabindex: "0", "data-grade": feedGrade(f),
      "aria-label": `Fetch error (fail streak ${f.fail_streak}): ${f.error}`,
    }, healthDot(f), tip);
    statusCell = el("td", { class: "status" }, wrap);
  } else {
    statusCell = el("td", { class: "status" }, healthDot(f));
  }
  const titleCell = el("td", { class: "title" },
    el("a", { class: "feed-title", href: f.url, target: "_blank", rel: "noopener" }, f.title));
  if (f.error) {
    titleCell.append(el("div", { class: "rowerr", "data-grade": feedGrade(f), "aria-hidden": "true" },
      el("span", { class: "streak" }, `fail ×${f.fail_streak}`),
      el("span", { class: "msg" }, f.error)));
  }
  return el("tr", { "data-src": String(srcColorIndex(f.id)) },
    statusCell,
    titleCell,
    el("td", { class: "tagcell" }, f.tag ? el("span", { class: "chip" }, f.tag) : ""),
    el("td", { class: "recipecell" }, f.recipe ? el("span", { class: "chip recipe", title: "recipe" }, f.recipe) : ""),
    // "never" = the feed has never fetched OK; "—" = fetching fine, but no new
    // article stamped yet (pre-vitals stores never stamped last_new).
    el("td", { class: "when lastnew", title: f.last_new ? new Date(f.last_new * 1000).toLocaleString() : null },
      f.last_new ? relTime(f.last_new) : f.last_ok ? "—" : "never"),
    el("td", { class: "when artcount" }, String(f.total_art)),
    el("td", { class: "actions" },
      el("button", { class: "btn icon", title: "Fetch this feed", "aria-label": "Fetch this feed", onclick: (e) => fetchOneFeed(f, e.currentTarget), html: ICON_FETCH }),
      el("button", { class: "btn icon", title: "Preview", "aria-label": "Preview", onclick: () => openPreviewDialog(f), html: ICON_PREVIEW }),
      el("button", { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openFeedModal(f), html: ICON_EDIT })));
}

// fetchOneFeed runs a single-feed fetch cycle (POST /api/fetch?id=N) from the
// row action: outcome in the banner, then a snapshot refresh redraws the row
// (which also re-enables the button by recreating it).
async function fetchOneFeed(f, btn) {
  btn.disabled = true;
  document.body.classList.add("fetching");
  let result = null, errMsg = "";
  try {
    await streamSSE("/api/fetch?id=" + f.id, ({ event, data }) => {
      if (event === "feed") { result = data; applyFeedEvent(data); }
      else if (event === "error") errMsg = data.error;
    });
  } catch (e) {
    errMsg = e.message;
  } finally {
    document.body.classList.remove("fetching");
  }
  if (errMsg) banner(errMsg);
  else if (result && result.error) banner(`${result.title}: ${result.error}`);
  else if (result) banner(`${result.title}: ${result.new} new article${result.new === 1 ? "" : "s"}`, true);
  try { await refresh(); } catch (e) { banner(e.message); }
}

// applyFeedEvent folds one SSE per-feed result into the cached snapshot and,
// on the Feeds tab, redraws board + table in place — the console ticks live
// while a cycle streams. The vitals are mirrored optimistically (the event
// carries only id/title/error/new); the authoritative post-stream refresh()
// reconciles any drift. fetched_at is deliberately untouched — it stamps at
// cycle commit, not per feed.
function applyFeedEvent(p) {
  const f = snapshot.feeds.find((x) => x.id === p.id);
  if (!f) return;
  const now = Math.floor(Date.now() / 1000);
  if (p.error) {
    f.error = p.error;
    f.fail_streak = (f.fail_streak || 0) + 1;
  } else {
    f.error = "";
    f.fail_streak = 0;
    f.last_ok = now;
    if (p.new) {
      f.last_new = now;
      f.total_art += p.new;
      snapshot.total_art += p.new;
    }
  }
  if (currentTab === "feeds") { drawBoard(); drawTable(); }
}

// fetchAllFromStrip runs the full fetch cycle from the pulse strip's inline
// action — the alarm carries its own remedy. Per-feed SSE events tick the
// board and table live; the final refresh() reconciles and, once fetched_at
// is fresh, clears the strip.
async function fetchAllFromStrip(btn) {
  if (document.body.classList.contains("fetching")) return;
  btn.disabled = true;
  document.body.classList.add("fetching");
  let errMsg = "", failed = 0;
  try {
    await streamSSE("/api/fetch", ({ event, data }) => {
      if (event === "feed") {
        if (data.error) failed++;
        applyFeedEvent(data);
      } else if (event === "error") errMsg = data.error;
    });
  } catch (e) {
    errMsg = e.message;
  } finally {
    document.body.classList.remove("fetching");
  }
  if (errMsg) banner(errMsg);
  else banner(failed ? `Fetch done — ${failed} feed${failed === 1 ? "" : "s"} failed` : "Fetch done", !failed);
  try { await refresh(); } catch (e) { banner(e.message); }
}

// Column comparators for the sortable headers. Numeric columns first-click
// descending (newest / biggest first — the triage order); title stays A→Z.
const FEED_SORTS = {
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  last_new: (a, b) => a.last_new - b.last_new,
  articles: (a, b) => a.total_art - b.total_art,
};

// sortableTh builds a sort-toggle header cell: a click cycles column/direction
// and redraws; aria-sort marks the active column for assistive tech.
function sortableTh(label, key) {
  const active = feedsState.sort === key;
  return el("th", { "aria-sort": active ? (feedsState.dir === 1 ? "ascending" : "descending") : null },
    el("button", {
      class: "th-sort",
      onclick: () => {
        if (feedsState.sort === key) feedsState.dir = -feedsState.dir;
        else { feedsState.sort = key; feedsState.dir = key === "title" ? 1 : -1; }
        drawTable();
      },
    }, label, active ? el("span", { class: "caret" }, feedsState.dir === 1 ? " ↑" : " ↓") : ""));
}

function drawTable() {
  const wrap = document.getElementById("feedTableWrap");
  const rows = snapshot.feeds.filter(feedMatches); // fresh array — in-place sort below never reorders the snapshot
  rows.sort((a, b) => FEED_SORTS[feedsState.sort](a, b) * feedsState.dir);
  const table = el("table", {},
    el("thead", {}, el("tr", {},
      el("th", {}, ""), sortableTh("title", "title"),
      el("th", {}, "tag"), el("th", {}, "recipe"),
      sortableTh("last new", "last_new"), sortableTh("articles", "articles"),
      el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const f of rows) tb.append(feedRow(f));
  table.append(tb);
  wrap.replaceChildren(
    el("div", { class: "count" }, `showing ${rows.length} of ${snapshot.feeds.length}`),
    table);
}

async function deleteFeed(f) {
  return confirmDelete(`Delete feed "${f.title}"?`, "/api/feeds/" + f.id, "Deleted " + f.title);
}

// importReq POSTs OPML XML to /api/import; dry=true only resolves and reports
// ({feeds, skipped}), dry=false commits ({imported, skipped}).
async function importReq(xml, dry) {
  const res = await fetch("/api/import" + (dry ? "?dry_run=1" : ""), {
    method: "POST", headers: { "Content-Type": "application/xml" }, body: xml });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

let importDialog;
// openImportModal shows the dry-run result — what will import, what gets
// skipped and why — before anything is written; Import runs the real thing.
function openImportModal(dry, xml) {
  importDialog ||= makeDialog({});
  const feeds = dry.feeds || [];
  const skipped = dry.skipped || [];
  const err = el("div", { class: "formerr" });
  const kids = [
    el("h3", {}, "Import OPML"),
    el("div", { class: "count" }, `${feeds.length} to import · ${skipped.length} skipped`),
  ];
  if (feeds.length) {
    const list = el("div", { class: "import-list" });
    for (const f of feeds)
      list.append(el("div", {}, el("b", {}, f.title || f.url), " ", el("span", { class: "muted" }, f.url)));
    kids.push(el("label", {}, "Will import"), list);
  } else {
    kids.push(el("div", { class: "muted" }, "Nothing to import."));
  }
  if (skipped.length) {
    const list = el("div", { class: "import-list" });
    for (const s of skipped)
      list.append(el("div", {}, el("span", { class: "bad" }, s.url), " ", el("span", { class: "muted" }, s.error)));
    kids.push(el("label", {}, "Skipped (unresolvable)"), list);
  }
  const doImport = el("button", { class: "btn primary", disabled: feeds.length ? null : "", onclick: async () => {
    try {
      const r = await importReq(xml, false);
      await refresh();
      importDialog.close();
      banner(`Imported ${r.imported}, skipped ${r.skipped.length}`, true);
    } catch (e) { err.textContent = e.message; }
  } }, "Import");
  kids.push(err, el("div", { class: "row" },
    el("button", { class: "btn", onclick: () => importDialog.close() }, "Cancel"), doImport));
  importDialog.replaceChildren(...kids);
  importDialog.showModal();
}

function makeDialog(attrs) {
  const d = el("dialog", attrs);
  document.body.append(d);
  return d;
}

let feedDialog;
// openFeedModal is both halves of feed CRUD. Add mode is URL-first: paste a
// site or feed URL and checkURL reads the wire's own label (GET /api/resolve)
// — a homepage folds to its discovered feed URL, the feed's title fills an
// empty title box, and the status line reports the signal check. Edit mode
// keeps the familiar title-first order; the same probe runs on a repointed URL.
function openFeedModal(f) {
  feedDialog ||= makeDialog({ id: "feedModal" });
  const isEdit = !!f;
  const v = f || { title: "", url: "", tag: "", recipe: "", no_title: false };
  const title = el("input", { id: "f_title", value: v.title,
    placeholder: isEdit ? null : "auto-filled from the feed" });
  const url = el("input", { id: "f_url", value: v.url,
    placeholder: "https://site.com/ — site or feed URL" });
  // The existing tag vocabulary rides as one-click toggle chips under the
  // input: a click fills it (clicking the active chip clears it), typing keeps
  // the highlight in sync, and free text still mints a new tag. Chips beat a
  // datalist here — the vocabulary is small and visible at a glance, and a
  // typo can't silently mint a near-duplicate of an existing tag.
  const tag = el("input", { id: "f_tag", value: v.tag || "", placeholder: "new or existing tag" });
  const tagChips = el("div", { class: "tag-chips" });
  function drawTagChips() {
    tagChips.replaceChildren();
    for (const t of snapshot.tags) {
      if (!t.tag) continue;
      const active = tag.value.trim() === t.tag;
      tagChips.append(el("button", {
        type: "button", class: "chip choice" + (active ? " active" : ""),
        "aria-pressed": active ? "true" : "false",
        onclick: () => { tag.value = active ? "" : t.tag; drawTagChips(); },
      }, t.tag));
    }
  }
  drawTagChips();
  tag.addEventListener("input", drawTagChips);
  // Recipes are a closed set, so the picker is chips alone — no input, no
  // select: one chip per recipe, `default` first, exactly one always active
  // (blank resolves to default). Dashed borders keep the table's tag-vs-recipe
  // distinction; picking one re-probes the URL through the new recipe.
  let recipeVal = v.recipe || "";
  const recipeChips = el("div", { class: "tag-chips" });
  function drawRecipeChips() {
    recipeChips.replaceChildren();
    const names = ["", ...Object.keys(snapshot.recipes).filter((n) => n !== "default").sort()];
    for (const n of names) {
      const active = recipeVal === n;
      recipeChips.append(el("button", {
        type: "button", class: "chip recipe choice" + (active ? " active" : ""),
        "aria-pressed": active ? "true" : "false",
        onclick: () => {
          if (recipeVal === n) return;
          recipeVal = n;
          drawRecipeChips();
          if (url.value.trim()) checkURL(true);
        },
      }, n || "default"));
    }
  }
  drawRecipeChips();
  const noTitle = el("input", { id: "f_notitle", type: "checkbox" });
  noTitle.checked = !!v.no_title;
  const err = el("div", { class: "formerr" });
  const status = el("div", { class: "resolve-status" });

  // checkURL probes the URL through the chosen recipe. Advisory only: a failed
  // probe reports in the status line but never blocks Save — the server
  // re-resolves on save regardless. Value-memoized (`probed`): paste and the
  // blur that follows it probe once, not twice, and a discovery-folded URL
  // counts as already checked; the explicit triggers (Enter, recipe change)
  // force a re-probe of the same value.
  let probing = false, probed = "";
  async function checkURL(force) {
    const u = url.value.trim();
    if (!u || probing || (!force && u === probed)) return;
    probing = true;
    status.replaceChildren(el("span", { class: "muted" }, "reading feed…"));
    try {
      const r = await apiGet(`/api/resolve?url=${encodeURIComponent(u)}&recipe=${encodeURIComponent(recipeVal)}`);
      if (url.value.trim() !== u) return; // field changed while probing — stale result
      if (r.url && r.url !== u) url.value = r.url; // homepage → its discovered feed
      probed = url.value.trim();
      if (!title.value.trim() && r.title) title.value = r.title;
      status.replaceChildren(el("i", { class: "dot green" }),
        el("span", {}, `${r.items} item${r.items === 1 ? "" : "s"}${r.title ? " · " + r.title : ""}`));
    } catch (e) {
      if (url.value.trim() === u) {
        probed = u; // a dead URL isn't re-hammered on every blur; Enter retries
        status.replaceChildren(el("span", { class: "bad" }, e.message));
      }
    } finally {
      probing = false;
    }
  }
  url.addEventListener("change", () => checkURL(false)); // blur with a modified value
  url.addEventListener("paste", () => setTimeout(() => checkURL(false), 0)); // pasted value lands next tick
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); checkURL(true); } });

  const save = el("button", { class: "btn primary", onclick: async () => {
    const body = {
      title: title.value.trim(), url: url.value.trim(),
      tag: tag.value.trim(), recipe: recipeVal,
      no_title: noTitle.checked,
    };
    save.disabled = true; // save re-resolves the URL server-side — it can take a moment
    try {
      await saveModal(feedDialog, err,
        () => isEdit ? api("PUT", "/api/feeds/" + f.id, body) : api("POST", "/api/feeds", body),
        (isEdit ? "Updated " : "Added ") + body.title);
    } finally {
      save.disabled = false;
    }
  } }, isEdit ? "Save" : "Add feed");

  const urlField = [el("label", {}, "URL"), url, status];
  const titleField = [el("label", {}, "Title"), title];
  feedDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit feed #" + f.id : "Add feed"),
    ...(isEdit ? [...titleField, ...urlField] : [...urlField, ...titleField]),
    el("label", {}, "Tag"), tag, tagChips,
    el("label", {}, "Recipe"), recipeChips,
    el("label", { class: "check" }, noTitle, "Hide article titles (titleless feed)"),
    err,
    dialogRow(feedDialog, save, isEdit ? () => deleteFeed(f) : null));
  feedDialog.showModal();
}

// --- recipes tab ------------------------------------------------------------
function renderRecipes() {
  const recipes = snapshot.recipes; // from the cached snapshot — no store read
  const root = document.getElementById("recipes");
  root.replaceChildren();
  root.append(el("div", { class: "toolbar" },
    el("button", { class: "btn primary", onclick: () => openRecipeModal(null, null) }, "+ New recipe")));

  const table = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "name"), el("th", {}, "ingest"), el("th", {}, "pipe"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const name of Object.keys(recipes).sort()) {
    const rcp = recipes[name];
    const actions = el("td", { class: "actions" },
      el("button", { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openRecipeModal(name, rcp), html: ICON_EDIT }));
    tb.append(el("tr", {},
      el("td", {}, el("span", { class: "chip" }, name)),
      el("td", {}, rcp.ingest ? el("span", { class: "chip" }, rcp.ingest) : el("span", { class: "muted" }, "#feed")),
      el("td", {}, pipeTokens(rcp.pipe)),
      actions));
  }
  table.append(tb);
  root.append(table);
  root.append(previewPanel(recipes));
}
renderers.recipes = renderRecipes;

async function deleteRecipe(name) {
  return confirmDelete(`Delete recipe "${name}"?`, "/api/recipes/" + encodeURIComponent(name), "Deleted recipe " + name);
}

let recipeDialog;
function openRecipeModal(name, rcp) {
  recipeDialog ||= makeDialog({});
  const isEdit = !!name;
  const nameIn = el("input", { value: name || "", disabled: isEdit ? "" : null });
  const ingestIn = el("input", { value: (rcp && rcp.ingest) || "", placeholder: "#feed (default)" });
  const steps = (rcp && rcp.pipe) ? [...rcp.pipe] : [];
  const stepsBox = el("div", {});
  const err = el("div", { class: "formerr" });

  function drawSteps() {
    stepsBox.replaceChildren();
    steps.forEach((s, i) => {
      const inp = el("input", { value: s, oninput: (e) => (steps[i] = e.target.value) });
      stepsBox.append(el("div", { class: "toolbar" }, inp,
        el("button", { class: "btn icon", title: "Remove step", "aria-label": "Remove step", onclick: () => { steps.splice(i, 1); drawSteps(); }, html: ICON_DELETE })));
    });
    stepsBox.append(el("button", { class: "btn", onclick: () => { steps.push(""); drawSteps(); } }, "+ step"));
  }
  drawSteps();

  const save = el("button", { class: "btn primary", onclick: async () => {
    err.textContent = "";
    const nm = (name || nameIn.value).trim();
    if (!nm) { err.textContent = "name required"; return; }
    const body = { ingest: ingestIn.value.trim(), pipe: steps.map((s) => s.trim()).filter(Boolean) };
    await saveModal(recipeDialog, err,
      () => api("PUT", "/api/recipes/" + encodeURIComponent(nm), body),
      (isEdit ? "Updated " : "Created ") + "recipe " + nm);
  } }, "Save");

  recipeDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit recipe" : "New recipe"),
    el("label", {}, "Name"), nameIn,
    el("label", {}, "Ingest (blank = inherit default)"), ingestIn,
    el("label", {}, "Pipe steps"), stepsBox,
    err,
    dialogRow(recipeDialog, save, isEdit && name !== "default" ? () => deleteRecipe(name) : null));
  recipeDialog.showModal();
}

// --- preview (Feeds-row dialog + Recipes-tab panel) --------------------------
// previewState keeps the panel's hand-typed url/recipe across tab switches.
const previewState = { url: "", recipe: "default" };

// renderPreviewInto renders /api/preview articles for url+recipe into `out`
// (loading line → article list, each body in a sandboxed inert iframe). Shared
// by the Recipes-tab panel and the Feeds-row preview dialog.
async function renderPreviewInto(out, url, recipe) {
  out.replaceChildren(el("div", { class: "muted" }, "loading…"));
  try {
    const arts = await apiGet(`/api/preview?url=${encodeURIComponent(url)}&recipe=${encodeURIComponent(recipe)}`);
    out.replaceChildren(el("div", { class: "muted" }, `${arts.length} articles`));
    for (const a of arts) {
      out.append(el("article", { class: "preview" },
        el("h4", {}, a.link ? el("a", { href: a.link, target: "_blank", rel: "noopener" }, a.title) : a.title),
        el("iframe", {
          class: "preview-frame",
          // Empty sandbox = scripts, inline event handlers and javascript: URLs all
          // disabled, so a recipe that omits #sanitize can't run feed-supplied JS on
          // the admin origin. srcdoc renders the HTML inert.
          sandbox: "",
          srcdoc: a.content,
        })));
    }
  } catch (e) { out.replaceChildren(el("div", { class: "muted" }, e.message)); }
}

let previewDialog;
// openPreviewDialog is the Feeds-row action: preview this feed's URL through
// its effective recipe in place — a dialog over the table, no tab switch.
function openPreviewDialog(f) {
  previewDialog ||= makeDialog({ class: "preview-dialog" });
  const out = el("div", { class: "preview-out" });
  previewDialog.replaceChildren(
    el("h3", {}, "Preview — " + f.title, " ", el("span", { class: "chip recipe", title: "recipe" }, f.recipe || "default")),
    out,
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: () => previewDialog.close() }, "Close")));
  previewDialog.showModal();
  renderPreviewInto(out, f.url, f.recipe || "default");
}

function previewPanel(recipes) {
  const url = el("input", { type: "url", placeholder: "https://example.com/feed", style: "min-width:24em",
    value: previewState.url, oninput: (e) => (previewState.url = e.target.value) });
  const recipeSel = el("select", { onchange: (e) => (previewState.recipe = e.target.value) },
    el("option", { value: "default" }, "default"));
  appendRecipeOptions(recipeSel, previewState.recipe, recipes);
  const out = el("div", {});
  const go = el("button", { class: "btn", onclick: () => renderPreviewInto(out, url.value, recipeSel.value) }, "Preview");
  return el("div", { style: "margin-top:1.6em" },
    el("h3", { class: "section-head" }, "Preview a recipe against a URL"),
    el("div", { class: "toolbar" }, url, recipeSel, go), out);
}

// --- syndicate tab ----------------------------------------------------------
function renderSyndicate() {
  const outs = snapshot.out; // from the cached snapshot — no store read
  const root = document.getElementById("syndicate");
  root.replaceChildren(el("div", { class: "toolbar" },
    el("button", { class: "btn primary", onclick: () => openOutModal(null) }, "+ New output")));
  if (!outs.length) {
    root.append(emptyState("No outputs yet",
      "Publish chosen tags or feeds as a rolling RSS or JSON feed. Writing them needs SRR_CDN_URL set on the fetch loop."));
    return;
  }
  const table = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "name"), el("th", {}, "format"), el("th", {}, "tags"),
    el("th", {}, "feeds"), el("th", {}, "limit"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const o of outs) {
    // With a CDN URL configured the name links the live out/<name> file the
    // fetch loop writes; without one there is nothing to link (writes skip).
    const name = snapshot.cdn_url
      ? el("a", { class: "chip", href: outFileURL(o), target: "_blank", rel: "noopener" }, o.name)
      : el("span", { class: "chip" }, o.name);
    tb.append(el("tr", {},
      el("td", {}, name),
      el("td", {}, el("span", { class: "chip" }, o.format)),
      el("td", {}, (o.tags || []).join(", ")),
      el("td", {}, feedRefs(o.feeds)),
      el("td", {}, String(o.limit || "")),
      el("td", { class: "actions" },
        el("button", { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openOutModal(o), html: ICON_EDIT }))));
  }
  table.append(tb);
  root.append(table);
}
renderers.syndicate = renderSyndicate;

const outFileURL = (o) =>
  snapshot.cdn_url.replace(/\/+$/, "") + "/out/" + o.name + (o.format === "json" ? ".json" : ".rss");

// feedRefs renders an output's feed-id selectors as feed titles (the operator
// picked titles, not numbers), falling back to #id for a since-deleted feed.
function feedRefs(ids) {
  const byId = new Map(snapshot.feeds.map((f) => [f.id, f.title]));
  return (ids || []).map((id) => byId.get(id) || "#" + id).join(", ");
}

async function deleteOut(name) {
  return confirmDelete(`Delete output "${name}"?`, "/api/syndicate/" + encodeURIComponent(name), "Deleted " + name);
}

// checkList renders a scrollable checkbox list and returns [element, selected
// Set]. Selection lives in the Set; the caller reads it at save time.
function checkList(items, initial) {
  const sel = new Set(initial);
  const box = el("div", { class: "picker" });
  if (!items.length) box.append(el("div", { class: "muted" }, "none available"));
  for (const it of items) {
    const cb = el("input", { type: "checkbox",
      onchange: () => (cb.checked ? sel.add(it.value) : sel.delete(it.value)) });
    cb.checked = sel.has(it.value);
    box.append(el("label", { class: "check" }, cb, it.label));
  }
  return [box, sel];
}

let outDialog;
function openOutModal(o) {
  outDialog ||= makeDialog({});
  const isEdit = !!o;
  const v = o || { name: "", title: "", format: "rss", tags: [], feeds: [], limit: 50 };
  const name = el("input", { value: v.name, disabled: isEdit ? "" : null });
  const fmt = el("select", {}, el("option", { value: "rss" }, "rss"), el("option", { value: "json" }, "json"));
  fmt.value = v.format;
  const title = el("input", { value: v.title || "" });
  // Selectors are picked from the snapshot (union of tags ∪ feeds), not typed
  // as raw names/ids — the operator shouldn't need to know feed numbers.
  const [tagsBox, tagSel] = checkList(
    snapshot.tags.filter((t) => t.tag)
      .map((t) => ({ value: t.tag, label: `${t.tag} (${t.feeds} feed${t.feeds === 1 ? "" : "s"})` })),
    v.tags || []);
  const [feedsBox, feedSel] = checkList(
    snapshot.feeds.map((f) => ({ value: f.id, label: f.title })),
    v.feeds || []);
  const limit = el("input", { type: "number", value: v.limit || 50 });
  const err = el("div", { class: "formerr" });
  const save = el("button", { class: "btn primary", onclick: async () => {
    const nm = (v.name || name.value).trim();
    const body = {
      title: title.value.trim(), format: fmt.value,
      tags: [...tagSel],
      feeds: [...feedSel],
      limit: Number(limit.value) || 0,
    };
    await saveModal(outDialog, err,
      () => api("PUT", "/api/syndicate/" + encodeURIComponent(nm), body),
      "Saved output " + nm);
  } }, "Save");
  outDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit output" : "New output"),
    el("label", {}, "Name"), name,
    el("label", {}, "Format"), fmt,
    el("label", {}, "Title"), title,
    el("label", {}, "Tags"), tagsBox,
    el("label", {}, "Feeds"), feedsBox,
    el("label", {}, "Limit"), limit,
    err,
    dialogRow(outDialog, save, isEdit ? () => deleteOut(o.name) : null));
  outDialog.showModal();
}

// --- tools tab --------------------------------------------------------------
function renderTools() {
  const root = document.getElementById("tools");
  root.replaceChildren();

  // Fetch always covers every feed in parallel — same as `srrb a fetch`.
  // Aborting the stream cancels the server-side cycle too (request context).
  const log = el("pre", { class: "log", "data-placeholder": "Idle — press Fetch now to stream the fetch log." });
  let aborter = null;
  const cancelBtn = el("button", { class: "btn", hidden: "", onclick: () => aborter && aborter.abort() }, "Cancel");
  const fetchBtn = el("button", { class: "btn primary", onclick: async () => {
    log.textContent = "";
    fetchBtn.disabled = true;
    cancelBtn.hidden = false;
    aborter = new AbortController();
    document.body.classList.add("fetching"); // "on the air" — pulses the masthead signal mark
    try {
      await streamSSE("/api/fetch", ({ event, data }) => {
        if (event === "feed") {
          log.textContent += `#${data.id} ${data.title}: ${data.error ? "ERROR " + data.error : data.new + " new"}\n`;
          applyFeedEvent(data); // keeps the cached snapshot live; guarded so Tools' DOM is never redrawn
        } else if (event === "done") log.textContent += "done.\n";
        else if (event === "error") log.textContent += "ERROR: " + data.error + "\n";
      }, aborter.signal);
    } catch (e) {
      log.textContent += aborter.signal.aborted ? "cancelled.\n" : "stream error: " + e.message + "\n";
    } finally {
      fetchBtn.disabled = false;
      cancelBtn.hidden = true;
      document.body.classList.remove("fetching");
    }
    // The cycle changed feed health and counts: re-pull the snapshot so the
    // Feeds tab isn't stale when the operator switches back. No redraw here —
    // that would wipe the log just streamed; tabs render on entry.
    try { await loadSnapshot(); } catch (e) { banner(e.message); }
  } }, "Fetch now");
  root.append(el("section", { class: "panel" },
    el("h3", {}, "Fetch"),
    el("div", { class: "toolbar" }, fetchBtn, cancelBtn), log));

  // Gen (from the cached snapshot)
  const genLabel = el("span", { class: "gen-readout" });
  const setGen = (n) => genLabel.replaceChildren("generation ", el("b", {}, String(n)));
  setGen(snapshot.gen);
  const bumpBtn = el("button", { class: "btn", onclick: async () => {
    if (!confirm("Bump the store generation? This forces every reader's service worker to purge its pack cache.")) return;
    try { const r = await api("POST", "/api/gen/bump"); snapshot.gen = r.gen; setGen(r.gen); banner("Bumped to " + r.gen, true); }
    catch (e) { banner(e.message); }
  } }, "Bump generation");
  root.append(el("section", { class: "panel" },
    el("h3", {}, "Generation"),
    el("div", { class: "toolbar" }, genLabel, bumpBtn),
    el("p", { class: "hint" }, "Bump after an in-place store rebuild so every reader purges its cached packs.")));

  // Inspect
  const out = el("pre", { class: "log", "data-placeholder": "No report yet — validate the store or look up a hash." });
  const hashIn = el("input", { placeholder: "hash e.g. 0,2485!big_info", style: "min-width:18em" });
  const runInspect = async (mode, extra) => {
    out.textContent = "running…";
    try { const r = await apiGet(`/api/inspect?mode=${mode}${extra || ""}`); out.textContent = (r.ok ? "" : "FAILED: " + (r.error || "") + "\n\n") + r.report; }
    catch (e) { out.textContent = e.message; }
  };
  root.append(el("section", { class: "panel" },
    el("h3", {}, "Inspect"),
    el("div", { class: "toolbar" },
      el("button", { class: "btn", onclick: () => runInspect("validate") }, "Validate store"),
      hashIn,
      el("button", { class: "btn", onclick: () => runInspect("from-hash", "&hash=" + encodeURIComponent(hashIn.value)) }, "From hash")),
    out));
}
renderers.tools = renderTools;

// Boot: pull the whole-store snapshot once, then render the hash-addressed tab
// (default Feeds) from it. Tab switches read this cache; the store is re-read
// here (a browser reload re-runs boot), after a mutation or fetch, and by the
// focus-refresh above.
(async () => {
  try {
    await loadSnapshot();
  } catch (e) {
    banner(e.message);
  }
  const want = location.hash.slice(1);
  showTab(renderers[want] ? want : "feeds");
})();
