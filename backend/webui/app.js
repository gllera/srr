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

function banner(msg, ok) {
  const b = document.getElementById("banner");
  b.textContent = msg;
  b.hidden = false;
  b.classList.toggle("ok", !!ok);
  if (ok) setTimeout(() => (b.hidden = true), 2500);
}
function clearBanner() { document.getElementById("banner").hidden = true; }

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

// confirmDelete is the shared confirm → DELETE → banner → refresh flow used by
// every tab's delete action.
async function confirmDelete(question, url, successMsg, refresh) {
  if (!confirm(question)) return;
  try {
    await api("DELETE", url);
    banner(successMsg, true);
    await refresh();
  } catch (e) {
    banner(e.message);
  }
}

// appendRecipeOptions fills a <select> with recipe-name options (skipping the
// implicit "default"), marking `selected` chosen. Pass the already-fetched
// recipes map to populate synchronously; omit it to fetch lazily.
function appendRecipeOptions(sel, selected, recipes) {
  const fill = (rs) => {
    for (const n of Object.keys(rs).sort()) {
      if (n === "default") continue;
      const o = el("option", { value: n }, n);
      if (n === selected) o.selected = true;
      sel.append(o);
    }
  };
  if (recipes) fill(recipes);
  else apiGet("/api/recipes").then(fill).catch((e) => banner("Could not load recipes: " + e.message));
}

// dialogRow is the shared Cancel + Save footer row every modal ends with.
function dialogRow(dlg, saveBtn) {
  return el("div", { class: "row" },
    el("button", { class: "btn", onclick: () => dlg.close() }, "Cancel"),
    saveBtn);
}

// --- tab router -------------------------------------------------------------
const renderers = {}; // tab name -> async render fn (filled by later phases)

function showTab(name) {
  for (const b of document.querySelectorAll("#tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  for (const s of document.querySelectorAll(".tab"))
    s.classList.toggle("active", s.id === name);
  clearBanner();
  const r = renderers[name];
  if (r) r().catch((e) => banner(e.message));
}

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));

showTab("feeds");

// --- feeds tab --------------------------------------------------------------
const feedsState = { feeds: [], tags: [], recipes: {}, search: "", tag: "" };
const UNTAGGED = "\x00"; // sentinel: the "(untagged)" filter option value, distinct from "" (= all tags)

function healthDot(f) {
  let cls = "green";
  if (f.error) cls = f.fail_streak >= 3 ? "red" : "amber";
  else if (!f.last_ok) cls = "gray";
  const title = f.error
    ? `${f.error} (fail streak ${f.fail_streak})`
    : f.last_ok
    ? "ok, last fetch " + new Date(f.last_ok * 1000).toLocaleString()
    : "never fetched";
  return el("span", { class: "dot " + cls, title });
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

async function renderFeeds() {
  [feedsState.feeds, feedsState.tags, feedsState.recipes] = await Promise.all([
    apiGet("/api/feeds"),
    apiGet("/api/tags"),
    apiGet("/api/recipes"),
  ]);
  drawFeeds();
}
renderers.feeds = renderFeeds;

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
  for (const t of feedsState.tags) {
    const optVal = t.tag === "" ? UNTAGGED : t.tag;
    const label = (t.tag || "(untagged)") + ` — ${t.feeds}`;
    const o = el("option", { value: optVal }, label);
    if (optVal === feedsState.tag) o.selected = true;
    tagSel.append(o);
  }
  const add = el("button", { class: "btn", onclick: () => openFeedModal(null) }, "+ Add feed");

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
        await renderFeeds();
      } catch (err) { banner(err.message); }
      e.target.value = "";
    } });
  const importBtn = el("button", { class: "btn", onclick: () => importInput.click() }, "Import OPML");
  root.append(el("div", { class: "toolbar" }, search, tagSel, add, importBtn, importInput, exportBtn));
  root.append(el("div", { id: "feedTableWrap" }));
  drawTable();
}

function drawTable() {
  const wrap = document.getElementById("feedTableWrap");
  const rows = feedsState.feeds.filter(feedMatches);
  const table = el("table", {},
    el("thead", {}, el("tr", {},
      el("th", {}, ""), el("th", {}, "title"), el("th", {}, "url"),
      el("th", {}, "tag"), el("th", {}, "recipe"),
      el("th", {}, "arts"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const f of rows) {
    tb.append(el("tr", {},
      el("td", {}, healthDot(f)),
      el("td", {}, f.title),
      el("td", {}, el("a", { href: f.url, target: "_blank", rel: "noopener" }, f.url)),
      el("td", {}, f.tag || ""),
      el("td", {}, f.recipe || ""),
      el("td", {}, String(f.total_art)),
      el("td", {},
        el("button", { class: "btn", onclick: () => openFeedModal(f) }, "edit"),
        " ",
        el("button", { class: "btn", onclick: () => deleteFeed(f) }, "✕"))));
  }
  table.append(tb);
  wrap.replaceChildren(
    el("div", { class: "muted" }, `${rows.length} of ${feedsState.feeds.length} feeds`),
    table);
}

async function deleteFeed(f) {
  return confirmDelete(`Delete feed "${f.title}"?`, "/api/feeds/" + f.id, "Deleted " + f.title, renderFeeds);
}

let feedDialog;
function openFeedModal(f) {
  if (!feedDialog) {
    feedDialog = el("dialog", { id: "feedModal" });
    document.body.append(feedDialog);
  }
  const isEdit = !!f;
  const v = f || { title: "", url: "", tag: "", recipe: "" };
  const title = el("input", { id: "f_title", value: v.title });
  const url = el("input", { id: "f_url", value: v.url });
  const tag = el("input", { id: "f_tag", value: v.tag || "" });
  const recipe = el("select", { id: "f_recipe" }, el("option", { value: "" }, "default"));
  appendRecipeOptions(recipe, v.recipe || "", feedsState.recipes);
  const err = el("div", { class: "muted" });

  const save = el("button", { class: "btn", onclick: async () => {
    const body = {
      title: title.value.trim(), url: url.value.trim(),
      tag: tag.value.trim(), recipe: recipe.value.trim(),
    };
    try {
      if (isEdit) await api("PUT", "/api/feeds/" + f.id, body);
      else await api("POST", "/api/feeds", body);
      await renderFeeds();
      feedDialog.close();
      banner((isEdit ? "Updated " : "Added ") + body.title, true);
    } catch (e) { err.textContent = e.message; }
  } }, "Save");

  feedDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit feed #" + f.id : "Add feed"),
    el("label", {}, "Title"), title,
    el("label", {}, "URL"), url,
    el("label", {}, "Tag"), tag,
    el("label", {}, "Recipe (blank = default)"), recipe,
    err,
    dialogRow(feedDialog, save));
  feedDialog.showModal();
}

// --- recipes tab ------------------------------------------------------------
async function renderRecipes() {
  const recipes = await apiGet("/api/recipes");
  const root = document.getElementById("recipes");
  root.replaceChildren();
  root.append(el("div", { class: "toolbar" },
    el("button", { class: "btn", onclick: () => openRecipeModal(null, null) }, "+ New recipe")));

  const table = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "name"), el("th", {}, "ingest"), el("th", {}, "pipe"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const name of Object.keys(recipes).sort()) {
    const rcp = recipes[name];
    const actions = el("td", {},
      el("button", { class: "btn", onclick: () => openRecipeModal(name, rcp) }, "edit"));
    if (name !== "default") {
      actions.append(" ", el("button", { class: "btn", onclick: () => deleteRecipe(name) }, "✕"));
    }
    tb.append(el("tr", {},
      el("td", {}, name),
      el("td", {}, rcp.ingest || ""),
      el("td", {}, (rcp.pipe || []).join("  →  ")),
      actions));
  }
  table.append(tb);
  root.append(table);
  root.append(previewPanel(recipes));
}
renderers.recipes = renderRecipes;

async function deleteRecipe(name) {
  return confirmDelete(`Delete recipe "${name}"?`, "/api/recipes/" + encodeURIComponent(name), "Deleted recipe " + name, renderRecipes);
}

let recipeDialog;
function openRecipeModal(name, rcp) {
  if (!recipeDialog) {
    recipeDialog = el("dialog", {});
    document.body.append(recipeDialog);
  }
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
        el("button", { class: "btn", onclick: () => { steps.splice(i, 1); drawSteps(); } }, "✕")));
    });
    stepsBox.append(el("button", { class: "btn", onclick: () => { steps.push(""); drawSteps(); } }, "+ step"));
  }
  drawSteps();

  const save = el("button", { class: "btn", onclick: async () => {
    err.textContent = "";
    const nm = (name || nameIn.value).trim();
    if (!nm) { err.textContent = "name required"; return; }
    const body = { ingest: ingestIn.value.trim(), pipe: steps.map((s) => s.trim()).filter(Boolean) };
    try {
      await api("PUT", "/api/recipes/" + encodeURIComponent(nm), body);
      recipeDialog.close();
      banner((isEdit ? "Updated " : "Created ") + "recipe " + nm, true);
      await renderRecipes();
    } catch (e) { err.textContent = e.message; }
  } }, "Save");

  recipeDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit recipe" : "New recipe"),
    el("label", {}, "Name"), nameIn,
    el("label", {}, "Ingest (blank = inherit default)"), ingestIn,
    el("label", {}, "Pipe steps"), stepsBox,
    err,
    dialogRow(recipeDialog, save));
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
          el("div", { class: "content", html: a.content })));
      }
    } catch (e) { out.replaceChildren(el("div", { class: "muted" }, e.message)); }
  } }, "Preview");
  return el("div", {},
    el("h3", {}, "Preview a recipe against a URL"),
    el("div", { class: "toolbar" }, url, recipeSel, go), out);
}

// --- syndicate tab ----------------------------------------------------------
async function renderSyndicate() {
  const outs = await apiGet("/api/syndicate");
  const root = document.getElementById("syndicate");
  root.replaceChildren(el("div", { class: "toolbar" },
    el("button", { class: "btn", onclick: () => openOutModal(null) }, "+ New output")));
  if (!outs.length) {
    root.append(el("div", { class: "muted" }, "No syndication outputs. (Writing them needs SRR_CDN_URL set on the fetch loop.)"));
  }
  const table = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "name"), el("th", {}, "format"), el("th", {}, "tags"),
    el("th", {}, "feeds"), el("th", {}, "limit"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const o of outs) {
    tb.append(el("tr", {},
      el("td", {}, o.name),
      el("td", {}, o.format),
      el("td", {}, (o.tags || []).join(", ")),
      el("td", {}, (o.feeds || []).join(", ")),
      el("td", {}, String(o.limit || "")),
      el("td", {},
        el("button", { class: "btn", onclick: () => openOutModal(o) }, "edit"), " ",
        el("button", { class: "btn", onclick: () => deleteOut(o.name) }, "✕"))));
  }
  table.append(tb);
  root.append(table);
}
renderers.syndicate = renderSyndicate;

async function deleteOut(name) {
  return confirmDelete(`Delete output "${name}"?`, "/api/syndicate/" + encodeURIComponent(name), "Deleted " + name, renderSyndicate);
}

let outDialog;
function openOutModal(o) {
  if (!outDialog) { outDialog = el("dialog", {}); document.body.append(outDialog); }
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
  const save = el("button", { class: "btn", onclick: async () => {
    const nm = (v.name || name.value).trim();
    const feedNums = feeds.value.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    if (feedNums.some(Number.isNaN)) { err.textContent = "Feed ids must be numbers"; return; }
    const body = {
      title: title.value.trim(), format: fmt.value,
      tags: tags.value.split(",").map((s) => s.trim()).filter(Boolean),
      feeds: feedNums,
      limit: Number(limit.value) || 0,
    };
    try {
      await api("PUT", "/api/syndicate/" + encodeURIComponent(nm), body);
      outDialog.close(); banner("Saved output " + nm, true); await renderSyndicate();
    } catch (e) { err.textContent = e.message; }
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
    dialogRow(outDialog, save));
  outDialog.showModal();
}

// --- tools tab --------------------------------------------------------------
async function renderTools() {
  const root = document.getElementById("tools");
  root.replaceChildren();

  // Fetch (both reads are independent — fetch them together)
  const [feeds, g] = await Promise.all([apiGet("/api/feeds"), apiGet("/api/gen")]);
  const feedSel = el("select", {}, el("option", { value: "" }, "all feeds"));
  for (const f of feeds) feedSel.append(el("option", { value: f.id }, `#${f.id} ${f.title}`));
  const log = el("pre", { class: "log" });
  const fetchBtn = el("button", { class: "btn", onclick: async () => {
    log.textContent = "";
    const q = feedSel.value ? "?feed=" + encodeURIComponent(feedSel.value) : "";
    fetchBtn.disabled = true;
    try {
      await streamSSE("/api/fetch" + q, ({ event, data }) => {
        if (event === "feed") log.textContent += `#${data.id} ${data.title}: ${data.error ? "ERROR " + data.error : data.new + " new"}\n`;
        else if (event === "done") log.textContent += "done.\n";
        else if (event === "error") log.textContent += "ERROR: " + data.error + "\n";
      });
    } catch (e) {
      log.textContent += "stream error: " + e.message + "\n";
    } finally {
      fetchBtn.disabled = false;
    }
  } }, "Fetch now");
  root.append(el("h3", {}, "Fetch"),
    el("div", { class: "toolbar" }, feedSel, fetchBtn), log);

  // Gen (g fetched above alongside feeds)
  const genLabel = el("span", {}, "generation: " + g.gen);
  const bumpBtn = el("button", { class: "btn", onclick: async () => {
    if (!confirm("Bump the store generation? This forces every reader's service worker to purge its pack cache.")) return;
    try { const r = await api("POST", "/api/gen/bump"); genLabel.textContent = "generation: " + r.gen; banner("Bumped to " + r.gen, true); }
    catch (e) { banner(e.message); }
  } }, "Bump generation");
  root.append(el("h3", {}, "Generation"), el("div", { class: "toolbar" }, genLabel, bumpBtn));

  // Inspect
  const out = el("pre", { class: "log" });
  const hashIn = el("input", { placeholder: "hash e.g. 0,2485!big_info", style: "min-width:18em" });
  const runInspect = async (mode, extra) => {
    out.textContent = "running…";
    try { const r = await apiGet(`/api/inspect?mode=${mode}${extra || ""}`); out.textContent = (r.ok ? "" : "FAILED: " + (r.error || "") + "\n\n") + r.report; }
    catch (e) { out.textContent = e.message; }
  };
  root.append(el("h3", {}, "Inspect"),
    el("div", { class: "toolbar" },
      el("button", { class: "btn", onclick: () => runInspect("validate") }, "Validate store"),
      hashIn,
      el("button", { class: "btn", onclick: () => runInspect("from-hash", "&hash=" + encodeURIComponent(hashIn.value)) }, "From hash")),
    out);
}
renderers.tools = renderTools;
