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

// streamSSE POSTs to path and invokes onEvent({event, data}) for each SSE frame.
async function streamSSE(path, onEvent) {
  const res = await fetch(path, { method: "POST" });
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
  for (const kid of kids) e.append(kid);
  return e;
}

// Inline monochrome icons (Feather-style, currentColor) shared by the row-action
// buttons (edit / delete) across every tab.
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_DELETE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

// Source-color slot for a feed id — mirrors the reader's fmt.srcColorIndex so a
// feed's rail color in the console matches the color it carries in the reader.
const SRC_COLORS = 8;
const srcColorIndex = (id) => ((id % SRC_COLORS) + SRC_COLORS) % SRC_COLORS;

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
let snapshot = { feeds: [], tags: [], recipes: {}, out: [], gen: 0 };
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
  for (const b of document.querySelectorAll("#tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  for (const s of document.querySelectorAll(".tab"))
    s.classList.toggle("active", s.id === name);
  clearBanner();
  drawTab();
}

// refresh re-pulls the snapshot and redraws the current tab. It deliberately
// does NOT clear the banner, so a caller can set a success message and then
// refresh the data under it.
async function refresh() {
  snapshot = await apiGet("/api/overview");
  drawTab();
}

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));

// --- feeds tab --------------------------------------------------------------
const feedsState = { search: "", tag: "" };
const UNTAGGED = "\x00"; // sentinel: the "(untagged)" filter option value, distinct from "" (= all tags)

// feedGrade buckets a feed's health: ok (live) / warn (failing, recoverable) /
// err (fault, streak >= 3) / idle (never fetched). The dot + board share it.
function feedGrade(f) {
  if (f.error) return f.fail_streak >= 3 ? "err" : "warn";
  return f.last_ok ? "ok" : "idle";
}
const GRADE_DOT = { ok: "green", warn: "amber", err: "red", idle: "gray" };

// healthDot is the small status dot. Its native title carries the health detail
// (last fetch / never fetched). For a failing feed the error rides a richer
// hover/focus tooltip instead (see feedRow).
function healthDot(f) {
  const title = f.last_ok
    ? "ok, last fetch " + new Date(f.last_ok * 1000).toLocaleString()
    : "never fetched";
  return el("span", { class: "dot " + GRADE_DOT[feedGrade(f)], title });
}

// healthBoard is the Feeds-tab hero: a one-line readout of the whole wire's
// health (total sources, then each non-empty grade with its count).
function healthBoard() {
  const c = { ok: 0, warn: 0, err: 0, idle: 0 };
  for (const f of snapshot.feeds) c[feedGrade(f)]++;
  const total = snapshot.feeds.length;
  const board = el("div", { class: "board" },
    el("span", { class: "total" }, el("b", {}, String(total)), total === 1 ? " source" : " sources"));
  const add = (n, dot, label) => {
    if (!n) return;
    board.append(el("span", { class: "stat" },
      el("i", { class: "dot " + dot }), el("b", {}, String(n)), " " + label));
  };
  add(c.ok, "green", "live");
  add(c.warn, "amber", "warn");
  add(c.err, "red", "fault");
  add(c.idle, "gray", "idle");
  return board;
}

function feedMatches(f) {
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
  const importInput = el("input", { type: "file", accept: ".opml,.xml,text/xml", style: "display:none",
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/xml" }, body: text });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        banner(`Imported ${data.imported}, skipped ${data.skipped.length}`, true);
        await refresh();
      } catch (err) { banner(err.message); }
      e.target.value = "";
    } });
  const importBtn = el("button", { class: "btn", onclick: () => importInput.click() }, "Import OPML");
  root.append(healthBoard());
  root.append(el("div", { class: "toolbar" }, search, tagSel, add, importBtn, importInput, exportBtn));
  root.append(el("div", { id: "feedTableWrap" }));
  drawTable();
}

// feedRow builds one Feeds-table row. A healthy feed shows a plain status dot; a
// failing feed wraps its dot in a focusable trigger that reveals the last fetch
// error as a hover/focus tooltip (the styled wire-log bubble; the wrapper's
// aria-label carries the same text for screen readers).
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
  return el("tr", { "data-src": String(srcColorIndex(f.id)) },
    statusCell,
    el("td", { class: "title" }, el("a", { class: "feed-title", href: f.url, target: "_blank", rel: "noopener" }, f.title)),
    el("td", {}, f.tag ? el("span", { class: "chip" }, f.tag) : ""),
    el("td", {}, f.recipe ? el("span", { class: "chip" }, f.recipe) : ""),
    el("td", { class: "actions" },
      el("button", { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openFeedModal(f), html: ICON_EDIT })));
}

function drawTable() {
  const wrap = document.getElementById("feedTableWrap");
  const rows = snapshot.feeds.filter(feedMatches);
  const table = el("table", {},
    el("thead", {}, el("tr", {},
      el("th", {}, ""), el("th", {}, "title"),
      el("th", {}, "tag"), el("th", {}, "recipe"),
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

function makeDialog(attrs) {
  const d = el("dialog", attrs);
  document.body.append(d);
  return d;
}

let feedDialog;
function openFeedModal(f) {
  feedDialog ||= makeDialog({ id: "feedModal" });
  const isEdit = !!f;
  const v = f || { title: "", url: "", tag: "", recipe: "" };
  const title = el("input", { id: "f_title", value: v.title });
  const url = el("input", { id: "f_url", value: v.url });
  const tag = el("input", { id: "f_tag", value: v.tag || "" });
  const recipe = el("select", { id: "f_recipe" }, el("option", { value: "" }, "default"));
  appendRecipeOptions(recipe, v.recipe || "", snapshot.recipes);
  const err = el("div", { class: "muted" });

  const save = el("button", { class: "btn primary", onclick: async () => {
    const body = {
      title: title.value.trim(), url: url.value.trim(),
      tag: tag.value.trim(), recipe: recipe.value.trim(),
    };
    await saveModal(feedDialog, err,
      () => isEdit ? api("PUT", "/api/feeds/" + f.id, body) : api("POST", "/api/feeds", body),
      (isEdit ? "Updated " : "Added ") + body.title);
  } }, "Save");

  feedDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit feed #" + f.id : "Add feed"),
    el("label", {}, "Title"), title,
    el("label", {}, "URL"), url,
    el("label", {}, "Tag"), tag,
    el("label", {}, "Recipe (blank = default)"), recipe,
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
  const err = el("div", { class: "muted" });

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

// --- inline preview (used inside the Recipes tab) ---------------------------
function previewPanel(recipes) {
  const url = el("input", { type: "url", placeholder: "https://example.com/feed", style: "min-width:24em" });
  const recipeSel = el("select", {}, el("option", { value: "default" }, "default"));
  appendRecipeOptions(recipeSel, "", recipes);
  const out = el("div", {});
  const go = el("button", { class: "btn", onclick: async () => {
    out.replaceChildren(el("div", { class: "muted" }, "loading…"));
    try {
      const arts = await apiGet(`/api/preview?url=${encodeURIComponent(url.value)}&recipe=${encodeURIComponent(recipeSel.value)}`);
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
            style: "width:100%;height:16em;border:1px solid var(--line,#3a3a3a);border-radius:6px;background:#fff",
          })));
      }
    } catch (e) { out.replaceChildren(el("div", { class: "muted" }, e.message)); }
  } }, "Preview");
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
    tb.append(el("tr", {},
      el("td", {}, el("span", { class: "chip" }, o.name)),
      el("td", {}, el("span", { class: "chip" }, o.format)),
      el("td", {}, (o.tags || []).join(", ")),
      el("td", {}, (o.feeds || []).join(", ")),
      el("td", {}, String(o.limit || "")),
      el("td", { class: "actions" },
        el("button", { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openOutModal(o), html: ICON_EDIT }))));
  }
  table.append(tb);
  root.append(table);
}
renderers.syndicate = renderSyndicate;

async function deleteOut(name) {
  return confirmDelete(`Delete output "${name}"?`, "/api/syndicate/" + encodeURIComponent(name), "Deleted " + name);
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
  const tags = el("input", { value: (v.tags || []).join(","), placeholder: "comma-separated tags" });
  const feeds = el("input", { value: (v.feeds || []).join(","), placeholder: "comma-separated feed ids" });
  const limit = el("input", { type: "number", value: v.limit || 50 });
  const err = el("div", { class: "muted" });
  const save = el("button", { class: "btn primary", onclick: async () => {
    const nm = (v.name || name.value).trim();
    const feedNums = feeds.value.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    if (feedNums.some(Number.isNaN)) { err.textContent = "Feed ids must be numbers"; return; }
    const body = {
      title: title.value.trim(), format: fmt.value,
      tags: tags.value.split(",").map((s) => s.trim()).filter(Boolean),
      feeds: feedNums,
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
    el("label", {}, "Tags"), tags,
    el("label", {}, "Feed ids"), feeds,
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
  const log = el("pre", { class: "log", "data-placeholder": "Idle — press Fetch now to stream the fetch log." });
  const fetchBtn = el("button", { class: "btn primary", onclick: async () => {
    log.textContent = "";
    fetchBtn.disabled = true;
    document.body.classList.add("fetching"); // "on the air" — pulses the masthead signal mark
    try {
      await streamSSE("/api/fetch", ({ event, data }) => {
        if (event === "feed") log.textContent += `#${data.id} ${data.title}: ${data.error ? "ERROR " + data.error : data.new + " new"}\n`;
        else if (event === "done") log.textContent += "done.\n";
        else if (event === "error") log.textContent += "ERROR: " + data.error + "\n";
      });
    } catch (e) {
      log.textContent += "stream error: " + e.message + "\n";
    } finally {
      fetchBtn.disabled = false;
      document.body.classList.remove("fetching");
    }
  } }, "Fetch now");
  root.append(el("section", { class: "panel" },
    el("h3", {}, "Fetch"),
    el("div", { class: "toolbar" }, fetchBtn), log));

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

// Boot: pull the whole-store snapshot once, then render the default tab from it.
// Tab switches read this cache; the store is re-read only here (a browser reload
// re-runs boot) and after a mutation. There is no in-app refresh — use reload.
(async () => {
  try {
    snapshot = await apiGet("/api/overview");
  } catch (e) {
    banner(e.message);
  }
  showTab("feeds");
})();
