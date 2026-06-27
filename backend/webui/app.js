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
const feedsState = { feeds: [], tags: [], search: "", tag: "" };
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
  [feedsState.feeds, feedsState.tags] = await Promise.all([
    apiGet("/api/feeds"),
    apiGet("/api/tags"),
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

  root.append(el("div", { class: "toolbar" }, search, tagSel, add));
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
  if (!confirm(`Delete feed "${f.title}"?`)) return;
  try {
    await api("DELETE", "/api/feeds/" + f.id);
    banner("Deleted " + f.title, true);
    await renderFeeds();
  } catch (e) { banner(e.message); }
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
  apiGet("/api/recipes").then((rs) => {
    for (const n of Object.keys(rs).sort()) {
      if (n === "default") continue;
      const o = el("option", { value: n }, n);
      if (n === (v.recipe || "")) o.selected = true;
      recipe.append(o);
    }
  }).catch((e) => banner("Could not load recipes: " + e.message));
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
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: () => feedDialog.close() }, "Cancel"),
      save));
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
  root.append(previewPanel());
}
renderers.recipes = renderRecipes;

async function deleteRecipe(name) {
  if (!confirm(`Delete recipe "${name}"?`)) return;
  try {
    await api("DELETE", "/api/recipes/" + encodeURIComponent(name));
    banner("Deleted recipe " + name, true);
    await renderRecipes();
  } catch (e) { banner(e.message); }
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
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: () => recipeDialog.close() }, "Cancel"), save));
  recipeDialog.showModal();
}

// --- inline preview (used inside the Recipes tab) ---------------------------
function previewPanel() {
  const url = el("input", { type: "url", placeholder: "https://example.com/feed", style: "min-width:24em" });
  const recipeSel = el("select", {}, el("option", { value: "default" }, "default"));
  apiGet("/api/recipes").then((rs) => {
    for (const n of Object.keys(rs).sort()) if (n !== "default") recipeSel.append(el("option", { value: n }, n));
  }).catch((e) => banner("Could not load recipes: " + e.message));
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
