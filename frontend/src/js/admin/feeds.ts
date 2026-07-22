// The Feeds tab: a triage-first health console — health board (grade-filter
// toggles), store-pulse alarm strip, searchable/sortable feed table, per-row
// fetch/preview/edit, and the add/edit feed modal with its URL probe and the
// Advanced fold. Ported from app.js's feeds section.

import { api, apiGet, streamSSE } from "./api"
import { banner } from "./banner"
import { el, icon, relTime, srcColorIndex } from "./dom"
import { renderers, refresh, state } from "./store"
import { renderPreviewInto } from "./preview"
import { confirmDelete, dialogRow, makeDialog, overrideChip, saveModal, stepsEditor } from "./ui"
import type { FeedListView, FeedProgress, ResolveResult } from "./types"

const feedsState = { search: "", tag: "", grade: "", sort: "title", dir: 1 }
const UNTAGGED = "\x00" // sentinel: the "(untagged)" filter option value, distinct from "" (= all tags)

// A feed that fetches fine but has produced nothing new for this long is a
// zombie candidate — the publisher stopped, moved, or broke silently.
const STALE_AFTER = 30 * 86400

// Store-pulse thresholds: how old the store-wide fetched_at may get before the
// console raises the alarm. The fetch loop normally cycles every few minutes,
// so hours of silence mean the loop itself is down.
const PULSE_AMBER_S = 6 * 3600
const PULSE_RED_S = 24 * 3600

// storePulse grades the store's own heartbeat (ok / amber / red) from the age
// of the last committed fetch. A never-fetched store with feeds is red (the
// loop has never run); an empty store is silent.
function storePulse(): string {
   if (!state.snapshot.fetched_at) return state.snapshot.feeds.length ? "red" : "ok"
   const age = Date.now() / 1000 - state.snapshot.fetched_at
   return age >= PULSE_RED_S ? "red" : age >= PULSE_AMBER_S ? "amber" : "ok"
}

// feedGrade buckets a feed's health: ok / warn / err / stale / idle.
function feedGrade(f: FeedListView): string {
   if (f.error) return f.fail_streak >= 3 ? "err" : "warn"
   if (!f.last_ok) return "idle"
   if (f.last_new && Date.now() / 1000 - f.last_new > STALE_AFTER) return "stale"
   return "ok"
}
const GRADE_DOT: Record<string, string> = { ok: "green", warn: "amber", err: "red", stale: "dim", idle: "gray" }

// healthDot is the small status dot. Its native title carries the health detail.
function healthDot(f: FeedListView): HTMLElement {
   const title = f.last_ok
      ? `last fetch ${relTime(f.last_ok)} · last new article ${relTime(f.last_new)}`
      : "never fetched"
   return el("span", { class: "dot " + GRADE_DOT[feedGrade(f)], title })
}

// healthBoard is the Feeds-tab hero: a one-line readout of the whole wire's
// health, plus store meta. Each grade stat is a filter toggle; the total resets.
function healthBoard(): HTMLElement {
   const c: Record<string, number> = { ok: 0, warn: 0, err: 0, stale: 0, idle: 0 }
   for (const f of state.snapshot.feeds) c[feedGrade(f)]++
   const total = state.snapshot.feeds.length
   const setGrade = (g: string) => {
      feedsState.grade = g
      drawBoard()
      drawTable()
   }
   const board = el(
      "div",
      { class: "board" },
      el(
         "button",
         { class: "total", title: "show all feeds", onclick: () => setGrade("") },
         el("b", {}, String(total)),
         total === 1 ? " source" : " sources",
      ),
   )
   const add = (grade: string, n: number, dot: string, label: string) => {
      if (!n) return
      const active = feedsState.grade === grade
      board.append(
         el(
            "button",
            {
               class: "stat" + (active ? " active" : ""),
               title: active ? "clear the filter" : "show only " + label + " feeds",
               onclick: () => setGrade(active ? "" : grade),
            },
            el("i", { class: "dot " + dot }),
            el("b", {}, String(n)),
            " " + label,
         ),
      )
   }
   add("ok", c.ok, "green", "live")
   add("warn", c.warn, "amber", "warn")
   add("err", c.err, "red", "fault")
   add("stale", c.stale, "dim", "stale")
   add("idle", c.idle, "gray", "idle")
   board.append(
      el(
         "span",
         { class: "meta" },
         `${state.snapshot.total_art.toLocaleString()} articles · `,
         el("span", { class: "pulse", "data-grade": storePulse() }, `fetched ${relTime(state.snapshot.fetched_at)}`),
      ),
   )
   return board
}

// pulseStrip is the store-level alarm surfacing hours of silence, with the
// remedy inline. Returns null while the pulse is healthy.
function pulseStrip(): HTMLElement | null {
   const grade = storePulse()
   if (grade === "ok") return null
   const btn = el(
      "button",
      {
         class: "btn",
         disabled: document.body.classList.contains("fetching") ? "" : null,
         onclick: (e: Event) => fetchAllFromStrip(e.currentTarget as HTMLButtonElement),
      },
      "Fetch now",
   )
   return el(
      "div",
      { class: "pulse-alert", "data-grade": grade, role: "alert" },
      el(
         "span",
         { class: "pulse-msg" },
         state.snapshot.fetched_at
            ? `last fetch ${relTime(state.snapshot.fetched_at)} — fetch loop may be down`
            : "store never fetched — fetch loop may be down",
      ),
      btn,
   )
}

// drawBoard fills the stable #feedsBoard container with [pulse alarm?, board] —
// kept apart from the toolbar so redraws never touch the search input.
function drawBoard(): void {
   const box = document.getElementById("feedsBoard")
   if (!box) return
   const strip = pulseStrip()
   box.replaceChildren(...(strip ? [strip] : []), healthBoard())
}

function feedMatches(f: FeedListView): boolean {
   if (feedsState.grade && feedGrade(f) !== feedsState.grade) return false
   if (feedsState.tag) {
      const want = feedsState.tag === UNTAGGED ? "" : feedsState.tag
      if ((f.tag || "") !== want) return false
   }
   if (feedsState.search) {
      const q = feedsState.search.toLowerCase()
      if (!(f.title + " " + f.url).toLowerCase().includes(q)) return false
   }
   return true
}

function drawFeeds(): void {
   const root = document.getElementById("feeds")!
   root.replaceChildren()

   const search = el("input", {
      type: "search",
      placeholder: "search title/url",
      value: feedsState.search,
      oninput: (e: Event) => {
         feedsState.search = (e.target as HTMLInputElement).value
         drawTable()
      },
   })
   const tagSel = el(
      "select",
      {
         onchange: (e: Event) => {
            feedsState.tag = (e.target as HTMLSelectElement).value
            drawTable()
         },
      },
      el("option", { value: "" }, "all tags"),
   )
   for (const t of state.snapshot.tags) {
      const optVal = t.tag === "" ? UNTAGGED : t.tag
      const label = (t.tag || "(untagged)") + ` — ${t.feeds}`
      const o = el("option", { value: optVal }, label)
      if (optVal === feedsState.tag) o.selected = true
      tagSel.append(o)
   }
   const add = el("button", { class: "btn primary", onclick: () => openFeedModal(null) }, "+ Add feed")

   root.append(el("div", { id: "feedsBoard" }))
   root.append(el("div", { class: "toolbar" }, search, tagSel, add))
   root.append(el("div", { id: "feedTableWrap" }))
   drawBoard()
   drawTable()
}

// liveArts is a feed's live article count: total_art is all-time, expired
// articles are gone from the reader.
const liveArts = (f: FeedListView): number => f.total_art - (f.expired || 0)

// feedRow builds one Feeds-table row: a status dot (a failing feed wraps it in a
// focusable error-tooltip trigger and carries the error inline), title, tag /
// recipe / override chips, last-new, live count, and the row actions.
function feedRow(f: FeedListView): HTMLElement {
   let statusCell: HTMLElement
   if (f.error) {
      const tip = el(
         "span",
         { class: "tip", "aria-hidden": "true" },
         el("span", { class: "streak" }, `fail ×${f.fail_streak}`),
         el("span", { class: "msg" }, f.error),
      )
      const wrap = el(
         "span",
         {
            class: "dotwrap",
            tabindex: "0",
            "data-grade": feedGrade(f),
            "aria-label": `Fetch error (fail streak ${f.fail_streak}): ${f.error}`,
         },
         healthDot(f),
         tip,
      )
      statusCell = el("td", { class: "status" }, wrap)
   } else {
      statusCell = el("td", { class: "status" }, healthDot(f))
   }
   const titleCell = el(
      "td",
      { class: "title" },
      el("a", { class: "feed-title", href: f.url, target: "_blank", rel: "noopener" }, f.title),
   )
   if (f.error) {
      titleCell.append(
         el(
            "div",
            { class: "rowerr", "data-grade": feedGrade(f), "aria-hidden": "true" },
            el("span", { class: "streak" }, `fail ×${f.fail_streak}`),
            el("span", { class: "msg" }, f.error),
         ),
      )
   }
   return el(
      "tr",
      { "data-src": String(srcColorIndex(f.id)) },
      statusCell,
      titleCell,
      el("td", { class: "tagcell" }, f.tag ? el("span", { class: "chip" }, f.tag) : ""),
      el(
         "td",
         { class: "recipecell" },
         f.recipe ? el("span", { class: "chip recipe", title: "recipe" }, f.recipe) : "",
         overrideChip(f),
      ),
      el(
         "td",
         { class: "when lastnew", title: f.last_new ? new Date(f.last_new * 1000).toLocaleString() : null },
         f.last_new ? relTime(f.last_new) : f.last_ok ? "—" : "never",
      ),
      el("td", { class: "when artcount" }, String(liveArts(f))),
      el(
         "td",
         { class: "actions" },
         el(
            "button",
            {
               class: "btn icon",
               title: "Fetch this feed",
               "aria-label": "Fetch this feed",
               onclick: (e: Event) => fetchOneFeed(f, e.currentTarget as HTMLButtonElement),
            },
            icon("fetch"),
         ),
         el(
            "button",
            { class: "btn icon", title: "Preview", "aria-label": "Preview", onclick: () => openPreviewDialog(f) },
            icon("preview"),
         ),
         el(
            "button",
            { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openFeedModal(f) },
            icon("edit"),
         ),
      ),
   )
}

// fetchOneFeed runs a single-feed fetch cycle (POST /api/fetch?id=N) from the
// row action: outcome in the banner, then a snapshot refresh redraws the row.
async function fetchOneFeed(f: FeedListView, btn: HTMLButtonElement): Promise<void> {
   btn.disabled = true
   document.body.classList.add("fetching")
   let result: FeedProgress | null = null
   let errMsg = ""
   try {
      await streamSSE("/api/fetch?id=" + f.id, ({ event, data }) => {
         if (event === "feed") {
            result = data as FeedProgress
            applyFeedEvent(result)
         } else if (event === "error") errMsg = (data as { error: string }).error
      })
   } catch (e) {
      errMsg = (e as Error).message
   } finally {
      document.body.classList.remove("fetching")
   }
   const r: FeedProgress | null = result
   if (errMsg) banner(errMsg)
   else if (r && r.error) banner(`${r.title}: ${r.error}`)
   else if (r) banner(`${r.title}: ${r.new} new article${r.new === 1 ? "" : "s"}`, true)
   try {
      await refresh()
   } catch (e) {
      banner((e as Error).message)
   }
}

// applyFeedEvent folds one SSE per-feed result into the cached snapshot and, on
// the Feeds tab, redraws board + table in place. The vitals are mirrored
// optimistically; the post-stream refresh() reconciles any drift. fetched_at is
// untouched — it stamps at cycle commit, not per feed.
export function applyFeedEvent(p: FeedProgress): void {
   const f = state.snapshot.feeds.find((x) => x.id === p.id)
   if (!f) return
   const now = Math.floor(Date.now() / 1000)
   if (p.error) {
      f.error = p.error
      f.fail_streak = (f.fail_streak || 0) + 1
   } else {
      f.error = ""
      f.fail_streak = 0
      f.last_ok = now
      if (p.new) {
         f.last_new = now
         f.total_art += p.new
         state.snapshot.total_art += p.new
      }
   }
   if (state.currentTab === "feeds") {
      drawBoard()
      drawTable()
   }
}

// fetchAllFromStrip runs the full fetch cycle from the pulse strip's inline
// action — the alarm carries its own remedy.
async function fetchAllFromStrip(btn: HTMLButtonElement): Promise<void> {
   if (document.body.classList.contains("fetching")) return
   btn.disabled = true
   document.body.classList.add("fetching")
   let errMsg = ""
   let failed = 0
   try {
      await streamSSE("/api/fetch", ({ event, data }) => {
         if (event === "feed") {
            const p = data as FeedProgress
            if (p.error) failed++
            applyFeedEvent(p)
         } else if (event === "error") errMsg = (data as { error: string }).error
      })
   } catch (e) {
      errMsg = (e as Error).message
   } finally {
      document.body.classList.remove("fetching")
   }
   if (errMsg) banner(errMsg)
   else banner(failed ? `Fetch done — ${failed} feed${failed === 1 ? "" : "s"} failed` : "Fetch done", !failed)
   try {
      await refresh()
   } catch (e) {
      banner((e as Error).message)
   }
}

// Column comparators for the sortable headers. Numeric columns first-click
// descending (the triage order); title stays A→Z.
const FEED_SORTS: Record<string, (a: FeedListView, b: FeedListView) => number> = {
   title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
   last_new: (a, b) => a.last_new - b.last_new,
   articles: (a, b) => liveArts(a) - liveArts(b),
}

// sortableTh builds a sort-toggle header cell; aria-sort marks the active column.
function sortableTh(label: string, key: string): HTMLElement {
   const active = feedsState.sort === key
   return el(
      "th",
      { "aria-sort": active ? (feedsState.dir === 1 ? "ascending" : "descending") : null },
      el(
         "button",
         {
            class: "th-sort",
            onclick: () => {
               if (feedsState.sort === key) feedsState.dir = -feedsState.dir
               else {
                  feedsState.sort = key
                  feedsState.dir = key === "title" ? 1 : -1
               }
               drawTable()
            },
         },
         label,
         active ? el("span", { class: "caret" }, feedsState.dir === 1 ? " ↑" : " ↓") : "",
      ),
   )
}

function drawTable(): void {
   const wrap = document.getElementById("feedTableWrap")!
   const rows = state.snapshot.feeds.filter(feedMatches) // fresh array — the in-place sort never reorders the snapshot
   rows.sort((a, b) => FEED_SORTS[feedsState.sort](a, b) * feedsState.dir)
   const table = el(
      "table",
      {},
      el(
         "thead",
         {},
         el(
            "tr",
            {},
            el("th", {}, ""),
            sortableTh("title", "title"),
            el("th", {}, "tag"),
            el("th", {}, "recipe"),
            sortableTh("last new", "last_new"),
            sortableTh("articles", "articles"),
            el("th", {}, ""),
         ),
      ),
   )
   const tb = el("tbody", {})
   for (const f of rows) tb.append(feedRow(f))
   table.append(tb)
   wrap.replaceChildren(
      el("div", { class: "count" }, `showing ${rows.length} of ${state.snapshot.feeds.length}`),
      table,
   )
}

async function deleteFeed(f: FeedListView): Promise<boolean> {
   return confirmDelete(`Delete feed "${f.title}"?`, "/api/feeds/" + f.id, "Deleted " + f.title)
}

let feedDialog: HTMLDialogElement | undefined
// openFeedModal is both halves of feed CRUD. Add mode is URL-first: paste a site
// or feed URL and checkURL reads the wire's own label (GET /api/resolve). Edit
// mode keeps the familiar title-first order; the same probe runs on a repointed URL.
function openFeedModal(f: FeedListView | null): void {
   feedDialog ||= makeDialog({ id: "feedModal" })
   const dlg = feedDialog
   const isEdit = !!f
   const v = f || {
      title: "",
      url: "",
      tag: "",
      recipe: "",
      ingest: "",
      pipe: [] as string[],
      no_title: false,
      expire_days: 0,
      dedup_days: 0,
      dedup_title: false,
   }
   const title = el("input", {
      id: "f_title",
      value: v.title,
      placeholder: isEdit ? null : "auto-filled from the feed",
   })
   const url = el("input", { id: "f_url", value: v.url, placeholder: "https://site.com/ — site or feed URL" })
   // The existing tag vocabulary rides as one-click toggle chips: a click fills
   // it (clicking the active chip clears it), typing keeps the highlight in sync,
   // and free text still mints a new tag.
   const tag = el("input", { id: "f_tag", value: v.tag || "", placeholder: "new or existing tag" })
   const tagChips = el("div", { class: "tag-chips" })
   function drawTagChips(): void {
      tagChips.replaceChildren()
      for (const t of state.snapshot.tags) {
         if (!t.tag) continue
         const active = tag.value.trim() === t.tag
         tagChips.append(
            el(
               "button",
               {
                  type: "button",
                  class: "chip choice" + (active ? " active" : ""),
                  "aria-pressed": active ? "true" : "false",
                  onclick: () => {
                     tag.value = active ? "" : t.tag
                     drawTagChips()
                  },
               },
               t.tag,
            ),
         )
      }
   }
   drawTagChips()
   tag.addEventListener("input", drawTagChips)
   // Recipes are a closed set, so the picker is chips alone — one chip per
   // recipe, `default` first, exactly one always active. Picking one re-probes.
   let recipeVal = v.recipe || ""
   const recipeChips = el("div", { class: "tag-chips" })
   function drawRecipeChips(): void {
      recipeChips.replaceChildren()
      const names = [
         "",
         ...Object.keys(state.snapshot.recipes)
            .filter((n) => n !== "default")
            .sort(),
      ]
      for (const n of names) {
         const active = recipeVal === n
         recipeChips.append(
            el(
               "button",
               {
                  type: "button",
                  class: "chip recipe choice" + (active ? " active" : ""),
                  "aria-pressed": active ? "true" : "false",
                  onclick: () => {
                     if (recipeVal === n) return
                     recipeVal = n
                     drawRecipeChips()
                     if (url.value.trim()) checkURL(true)
                  },
               },
               n || "default",
            ),
         )
      }
   }
   drawRecipeChips()
   // Feed-level {ingest, pipe} overrides: rarely used, but they must round-trip
   // — the save body is full-replace, so omitting them would wipe an override.
   const ingestIn = el("input", { id: "f_ingest", value: v.ingest || "", placeholder: "inherits the recipe's ingest" })
   const pipeSteps = [...(v.pipe || [])]
   const pipeBox = stepsEditor(pipeSteps, {
      placeholder: "#sanitize or a shell command",
      emptyNote: "using the recipe's pipe",
      hint: "Replaces the recipe's pipe. #default expands to it.",
   })
   const noTitle = el("input", { id: "f_notitle", type: "checkbox" })
   noTitle.checked = !!v.no_title
   const expire = el("input", {
      id: "f_expire",
      type: "number",
      min: "0",
      max: "36500",
      step: "1",
      value: v.expire_days ? String(v.expire_days) : "",
      placeholder: "0",
   })
   // Seen.gz dedup pool overrides. dedup_days: 0 inherits the store default, a
   // positive N sets this feed's horizon, -1 disables the pool for it.
   const dedupDays = el("input", {
      id: "f_dedup",
      type: "number",
      min: "-1",
      max: "36500",
      step: "1",
      value: v.dedup_days ? String(v.dedup_days) : "",
      placeholder: "0",
   })
   const dedupTitle = el("input", { id: "f_deduptitle", type: "checkbox" })
   dedupTitle.checked = !!v.dedup_title
   // Clamp to [-1, 36500]; empty/NaN → 0 (inherit). Shared by save + summary chip.
   const dedupVal = () => Math.max(-1, Math.min(36500, Math.floor(Number(dedupDays.value) || 0)))
   const err = el("div", { class: "formerr" })
   const status = el("div", { class: "resolve-status" })

   // checkURL probes the URL through the chosen recipe. Advisory only: a failed
   // probe reports in the status line but never blocks Save. Value-memoized.
   let probing = false
   let probed = ""
   async function checkURL(force: boolean): Promise<void> {
      const u = url.value.trim()
      if (!u || probing || (!force && u === probed)) return
      probing = true
      status.replaceChildren(el("span", { class: "muted" }, "reading feed…"))
      try {
         const r = (await apiGet(
            `/api/resolve?url=${encodeURIComponent(u)}&recipe=${encodeURIComponent(recipeVal)}&ingest=${encodeURIComponent(ingestIn.value.trim())}`,
         )) as ResolveResult
         if (url.value.trim() !== u) return // field changed while probing — stale result
         if (r.url && r.url !== u) url.value = r.url // homepage → its discovered feed
         probed = url.value.trim()
         if (!title.value.trim() && r.title) title.value = r.title
         status.replaceChildren(
            el("i", { class: "dot green" }),
            el("span", {}, `${r.items} item${r.items === 1 ? "" : "s"}${r.title ? " · " + r.title : ""}`),
         )
      } catch (e) {
         if (url.value.trim() === u) {
            probed = u // a dead URL isn't re-hammered on every blur; Enter retries
            status.replaceChildren(el("span", { class: "bad" }, (e as Error).message))
         }
      } finally {
         probing = false
      }
   }
   url.addEventListener("change", () => checkURL(false)) // blur with a modified value
   url.addEventListener("paste", () => setTimeout(() => checkURL(false), 0)) // pasted value lands next tick
   url.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
         e.preventDefault()
         checkURL(true)
      }
   })
   ingestIn.addEventListener("change", () => {
      if (url.value.trim()) checkURL(true)
   })

   const save = el(
      "button",
      {
         class: "btn primary",
         onclick: async () => {
            if (!url.value.trim()) {
               err.textContent = "a URL is required"
               url.focus()
               return
            }
            const body = {
               title: title.value.trim(),
               url: url.value.trim(),
               tag: tag.value.trim(),
               recipe: recipeVal,
               ingest: ingestIn.value.trim(),
               pipe: pipeSteps.map((s) => s.trim()).filter(Boolean),
               no_title: noTitle.checked,
               expire_days: Math.max(0, Math.floor(Number(expire.value) || 0)),
               dedup_days: dedupVal(),
               dedup_title: dedupTitle.checked,
            }
            save.disabled = true // save re-resolves the URL server-side — it can take a moment
            try {
               await saveModal(
                  dlg,
                  err,
                  () => (isEdit ? api("PUT", "/api/feeds/" + f!.id, body) : api("POST", "/api/feeds", body)),
                  (isEdit ? "Updated " : "Added ") + body.title,
               )
            } finally {
               save.disabled = false
            }
         },
      },
      isEdit ? "Save" : "Add feed",
   )

   // The advanced fold: overrides, retention and display flags live behind a
   // native <details>. It opens itself when anything inside is non-default; while
   // closed the summary wears one chip per value set.
   const advValues = (): string[] => {
      const days = Math.max(0, Math.floor(Number(expire.value) || 0))
      const dd = dedupVal()
      return [
         ingestIn.value.trim() && "ingest",
         pipeSteps.some((s) => s.trim()) && "pipe",
         days > 0 && `expire ${days}d`,
         dd === -1 ? "dedup off" : dd > 0 && `dedup ${dd}d`,
         dedupTitle.checked && "dedup title",
         noTitle.checked && "no titles",
      ].filter(Boolean) as string[]
   }
   const advChips = el("span", { class: "adv-chips" })
   const drawAdvChips = () => advChips.replaceChildren(...advValues().map((t) => el("span", { class: "chip" }, t)))
   drawAdvChips()
   const adv = el(
      "details",
      { class: "adv", ontoggle: drawAdvChips },
      el("summary", {}, "Advanced", advChips),
      el("label", {}, "Ingest"),
      ingestIn,
      el("p", { class: "hint" }, "Only this feed. #feed or a shell command."),
      el("label", {}, "Pipe"),
      pipeBox,
      el(
         "div",
         { class: "field-duo" },
         el(
            "div",
            { class: "field" },
            el("label", {}, "Expire after"),
            el("div", { class: "inline-field" }, expire, el("span", { class: "unit" }, "days")),
            el("p", { class: "hint" }, "0 keeps articles forever."),
         ),
         el(
            "div",
            { class: "field" },
            el("label", {}, "Dedup pool"),
            el("div", { class: "inline-field" }, dedupDays, el("span", { class: "unit" }, "days")),
            el("p", { class: "hint" }, "0 = store default; -1 disables it here."),
         ),
      ),
      el(
         "div",
         { class: "field-duo" },
         el(
            "div",
            { class: "field" },
            el("label", { class: "check" }, noTitle, "Hide article titles"),
            el("p", { class: "hint" }, "For microblog feeds without real titles."),
         ),
         el(
            "div",
            { class: "field" },
            el("label", { class: "check" }, dedupTitle, "Also dedup by title"),
            el("p", { class: "hint" }, "A re-post with a new guid but the same headline."),
         ),
      ),
   )
   if (advValues().length) adv.open = true

   const urlField = [el("label", {}, "URL"), url, status]
   const titleField = [el("label", {}, "Title"), title]
   dlg.replaceChildren(
      el("h3", {}, isEdit ? "Edit feed #" + f!.id : "Add feed"),
      ...(isEdit ? [...titleField, ...urlField] : [...urlField, ...titleField]),
      el("label", {}, "Tag"),
      tag,
      tagChips,
      el("label", {}, "Recipe"),
      recipeChips,
      adv,
      err,
      dialogRow(dlg, save, isEdit ? () => deleteFeed(f!) : null),
   )
   dlg.showModal()
}

let previewDialog: HTMLDialogElement | undefined
// openPreviewDialog is the Feeds-row action: preview this feed's URL through its
// effective recipe in place — a dialog over the table, no tab switch.
function openPreviewDialog(f: FeedListView): void {
   previewDialog ||= makeDialog({ class: "preview-dialog" })
   const dlg = previewDialog
   const out = el("div", { class: "preview-out" })
   dlg.replaceChildren(
      el(
         "h3",
         {},
         "Preview — " + f.title,
         " ",
         el("span", { class: "chip recipe", title: "recipe" }, f.recipe || "default"),
         " ",
         overrideChip(f),
      ),
      out,
      el("div", { class: "row" }, el("button", { class: "btn", onclick: () => dlg.close() }, "Close")),
   )
   dlg.showModal()
   renderPreviewInto(out, f.url, f.recipe || "default", f.pipe, f.ingest)
}

renderers.feeds = drawFeeds
