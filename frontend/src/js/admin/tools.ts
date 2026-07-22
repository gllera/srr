// The Tools tab: the streamed fetch panel (with cancel), the OPML import review
// sheet + export (OPML and the lossless JSON config export, §33), the store-wide
// dedup default, the read-only generation readout, and the inspect console. This
// tab is never redrawn in place — that would wipe its streamed logs. Ported from
// app.js's tools section (which also housed openImportModal).

import { api, apiGet, streamSSE } from "./api"
import { banner, clearBanner } from "./banner"
import { el } from "./dom"
import { applyFeedEvent } from "./feeds"
import { loadSnapshot, renderers, state } from "./store"
import { appendRecipeOptions, dialogRow, makeDialog, saveModal } from "./ui"
import type { FeedProgress, ImportDryRun, ImportFeed, InspectResult } from "./types"

// importDryRun POSTs OPML XML to /api/import?dry_run=1: the server walks the
// outline tree and resolves every URL without writing anything — {feeds, skipped}.
async function importDryRun(xml: string): Promise<ImportDryRun> {
   const res = await fetch("/api/import?dry_run=1", {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
   })
   const data = await res.json()
   if (!res.ok) throw new Error((data && data.error) || res.statusText)
   return data as ImportDryRun
}

interface ImportRow {
   on: boolean
   known: boolean
   url: string
   error: string
   check: HTMLInputElement
   title: HTMLInputElement
   tag: HTMLInputElement
   recipe: HTMLSelectElement
   el?: HTMLElement
}

let importDialog: HTMLDialogElement | undefined
// openImportModal is the OPML review sheet: every OPML feed is an editable row —
// include-checkbox, title, tag, recipe — so the operator prunes and adjusts the
// set before anything is written. A subscribed URL starts unchecked; an
// unresolvable one is a row too (a different recipe may resolve it), unchecked
// with its error inline. Import commits the checked rows via /api/feeds/apply.
function openImportModal(dry: ImportDryRun): void {
   importDialog ||= makeDialog({ class: "import-dialog" })
   const dlg = importDialog
   const subscribed = new Set(state.snapshot.feeds.map((f) => f.url))
   const err = el("div", { class: "formerr" })
   const counts = el("div", { class: "count" })
   const master = el("input", { type: "checkbox" })
   const importBtn = el("button", { class: "btn primary" }, "Import")

   const rows: ImportRow[] = [...(dry.feeds || []), ...(dry.skipped || [])].map((f: ImportFeed) => {
      const known = subscribed.has(f.url)
      const recipe = el("select", { class: "imp-recipe" }, el("option", { value: "" }, "default"))
      appendRecipeOptions(recipe, f.recipe || "", state.snapshot.recipes)
      return {
         on: !known && !f.error,
         known,
         url: f.url,
         error: f.error || "",
         check: el("input", { type: "checkbox" }),
         title: el("input", { class: "imp-title", value: f.title || "", placeholder: "title (required)" }),
         tag: el("input", { class: "imp-tag", value: f.tag || "", placeholder: "tag" }),
         recipe,
      }
   })

   function syncHeader(): void {
      const n = rows.filter((r) => r.on).length
      const unres = rows.filter((r) => r.error).length
      counts.textContent = `${n} of ${rows.length} selected` + (unres ? ` · ${unres} unresolved` : "")
      importBtn.textContent = n ? `Import ${n} feed${n === 1 ? "" : "s"}` : "Import"
      importBtn.disabled = n === 0
      master.checked = n > 0 && n === rows.length
      master.indeterminate = n > 0 && n < rows.length
   }

   const list = el("div", { class: "import-review" })
   for (const r of rows) {
      r.check.checked = r.on
      r.el = el(
         "div",
         { class: "import-row" + (r.on ? "" : " off") },
         r.check,
         r.title,
         r.tag,
         r.recipe,
         el(
            "div",
            { class: "import-url" },
            r.known ? el("span", { class: "dup" }, "subscribed") : "",
            r.error ? el("span", { class: "unres" }, "unresolved") : "",
            el("span", { class: "muted" }, r.url + (r.error ? " — " + r.error : "")),
         ),
      )
      r.check.addEventListener("change", () => {
         r.on = r.check.checked
         r.el!.classList.toggle("off", !r.on)
         syncHeader()
      })
      list.append(r.el)
   }
   master.addEventListener("change", () => {
      for (const r of rows) {
         r.on = master.checked
         r.check.checked = r.on
         r.el!.classList.toggle("off", !r.on)
      }
      syncHeader()
   })

   importBtn.addEventListener("click", async () => {
      const sel = rows.filter((r) => r.on)
      const blank = sel.find((r) => !r.title.value.trim())
      if (blank) {
         err.textContent = "every selected feed needs a title"
         blank.title.focus()
         return
      }
      const body = sel.map((r) => ({
         title: r.title.value.trim(),
         url: r.url,
         tag: r.tag.value.trim(),
         recipe: r.recipe.value,
      }))
      importBtn.disabled = true
      try {
         await saveModal(
            dlg,
            err,
            () => api("POST", "/api/feeds/apply", body),
            `Imported ${body.length} feed${body.length === 1 ? "" : "s"}`,
         )
      } finally {
         importBtn.disabled = false
      }
   })

   const kids: Node[] = [el("h3", {}, "Import OPML"), counts]
   if (rows.length) {
      kids.push(el("label", { class: "check" }, master, "select all"), list)
   } else {
      kids.push(el("div", { class: "muted" }, "Nothing to import."))
   }
   syncHeader()
   kids.push(err, dialogRow(dlg, importBtn, null))
   dlg.replaceChildren(...kids)
   dlg.showModal()
}

function renderTools(): void {
   const root = document.getElementById("tools")!
   root.replaceChildren()

   // Fetch always covers every feed in parallel. Aborting the stream cancels
   // the server-side cycle too (request context).
   const log = el("pre", { class: "log", "data-placeholder": "Idle — press Fetch now to stream the fetch log." })
   let aborter: AbortController | null = null
   const cancelBtn = el("button", { class: "btn", hidden: "", onclick: () => aborter && aborter.abort() }, "Cancel")
   const fetchBtn = el(
      "button",
      {
         class: "btn primary",
         onclick: async () => {
            log.textContent = ""
            fetchBtn.disabled = true
            cancelBtn.hidden = false
            aborter = new AbortController()
            document.body.classList.add("fetching") // "on the air" — pulses the masthead signal mark
            try {
               await streamSSE(
                  "/api/fetch",
                  ({ event, data }) => {
                     if (event === "feed") {
                        const p = data as FeedProgress
                        log.textContent += `#${p.id} ${p.title}: ${p.error ? "ERROR " + p.error : p.new + " new"}\n`
                        applyFeedEvent(p) // keeps the cached snapshot live; guarded so Tools' DOM is never redrawn
                     } else if (event === "done") log.textContent += "done.\n"
                     else if (event === "error") log.textContent += "ERROR: " + (data as { error: string }).error + "\n"
                  },
                  aborter.signal,
               )
            } catch (e) {
               log.textContent += aborter.signal.aborted
                  ? "cancelled.\n"
                  : "stream error: " + (e as Error).message + "\n"
            } finally {
               fetchBtn.disabled = false
               cancelBtn.hidden = true
               document.body.classList.remove("fetching")
            }
            // The cycle changed feed health and counts: re-pull the snapshot so
            // the Feeds tab isn't stale. No redraw here — that would wipe the log.
            try {
               await loadSnapshot()
            } catch (e) {
               banner((e as Error).message)
            }
         },
      },
      "Fetch now",
   )
   root.append(
      el(
         "section",
         { class: "panel" },
         el("h3", {}, "Fetch"),
         el("div", { class: "toolbar" }, fetchBtn, cancelBtn),
         log,
      ),
   )

   // OPML — the feed set as a portable document. Import is a two-step flow: a dry
   // run first, then the review sheet. Export has two shapes: OPML 2.0 (the feed
   // set) and the lossless whole-configuration JSON document (§33).
   const importInput = el("input", {
      type: "file",
      class: "hidden",
      accept: ".opml,.xml,text/xml",
      onchange: async (e: Event) => {
         const input = e.target as HTMLInputElement
         const file = input.files?.[0]
         input.value = ""
         if (!file) return
         banner("Resolving OPML feeds…", true)
         try {
            const dry = await importDryRun(await file.text())
            clearBanner()
            openImportModal(dry)
         } catch (err) {
            banner((err as Error).message)
         }
      },
   })
   root.append(
      el(
         "section",
         { class: "panel" },
         el("h3", {}, "OPML"),
         el(
            "div",
            { class: "toolbar" },
            el("button", { class: "btn", onclick: () => importInput.click() }, "Import OPML"),
            importInput,
            el("button", { class: "btn", onclick: () => (window.location.href = "/api/export") }, "Export OPML"),
            el(
               "button",
               { class: "btn", onclick: () => (window.location.href = "/api/export?format=json") },
               "Export config (JSON)",
            ),
         ),
         el(
            "p",
            { class: "hint" },
            "Import opens a review sheet — pick and edit each feed before anything is written. Export OPML downloads every feed as OPML 2.0; Export config downloads the lossless whole-configuration JSON.",
         ),
      ),
   )

   // Dedup pool — the store-wide default seen.gz horizon (the fallback for feeds
   // whose own dedup-days is 0). No off switch here (min 0, 0 resets to default).
   const dedupIn = el("input", {
      class: "dedup-in",
      type: "number",
      min: "0",
      max: "36500",
      step: "1",
      value: String(state.snapshot.dedup_days || ""),
   })
   const dedupSave = el(
      "button",
      {
         class: "btn",
         onclick: async () => {
            const days = Math.max(0, Math.min(36500, Math.floor(Number(dedupIn.value) || 0)))
            dedupSave.disabled = true
            try {
               const r = (await api("PUT", "/api/dedup", { days })) as { dedup_days: number }
               state.snapshot.dedup_days = r.dedup_days
               dedupIn.value = String(r.dedup_days) // re-show the effective default after a 0 reset
               banner("Dedup default set to " + r.dedup_days + " days", true)
            } catch (e) {
               banner((e as Error).message)
            } finally {
               dedupSave.disabled = false
            }
         },
      },
      "Save",
   )
   root.append(
      el(
         "section",
         { class: "panel" },
         el("h3", {}, "Dedup pool"),
         el(
            "div",
            { class: "toolbar" },
            el("span", {}, "Store default horizon"),
            el("div", { class: "inline-field" }, dedupIn, el("span", { class: "unit" }, "days")),
            dedupSave,
         ),
         el(
            "p",
            { class: "hint" },
            "Fallback for feeds whose own dedup-days is 0. Set a feed's to -1 to disable the pool for it, or a positive horizon to override. 0 here resets to the built-in default.",
         ),
      ),
   )

   // Store generation (read-only: the manifest counter the root points at).
   root.append(
      el(
         "section",
         { class: "panel" },
         el("h3", {}, "Generation"),
         el(
            "div",
            { class: "toolbar" },
            el("span", { class: "gen-readout" }, "manifest ", el("b", {}, String(state.snapshot.m ?? 0))),
         ),
         el(
            "p",
            { class: "hint" },
            "Every commit publishes one immutable generation manifest and repoints db.gz at it. Names are never reused, so there is nothing to invalidate and no cache to purge.",
         ),
      ),
   )

   // Inspect.
   const out = el("pre", { class: "log", "data-placeholder": "No report yet — validate the store or look up a hash." })
   const hashIn = el("input", { class: "hash-in", placeholder: "hash e.g. 0,2485!big_info" })
   const runInspect = async (mode: string, extra?: string) => {
      out.textContent = "running…"
      try {
         const r = (await apiGet(`/api/inspect?mode=${mode}${extra || ""}`)) as InspectResult
         out.textContent = (r.ok ? "" : "FAILED: " + (r.error || "") + "\n\n") + r.report
      } catch (e) {
         out.textContent = (e as Error).message
      }
   }
   root.append(
      el(
         "section",
         { class: "panel" },
         el("h3", {}, "Inspect"),
         el(
            "div",
            { class: "toolbar" },
            el("button", { class: "btn", onclick: () => runInspect("validate") }, "Validate store"),
            hashIn,
            el(
               "button",
               { class: "btn", onclick: () => runInspect("from-hash", "&hash=" + encodeURIComponent(hashIn.value)) },
               "From hash",
            ),
         ),
         out,
      ),
   )
}

renderers.tools = renderTools
