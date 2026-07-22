// The Syndicate tab: the output table (linking the live out/<name> file when a
// CDN URL is configured) and the create/edit output modal (format, external
// flag, tag/feed checklists, limit). Ported from app.js's syndicate section.

import { api } from "./api"
import { el, icon } from "./dom"
import { renderers, state } from "./store"
import { checkList, confirmDelete, dialogRow, emptyState, makeDialog, saveModal } from "./ui"
import type { OutFeed } from "./types"

const outFileURL = (o: OutFeed): string =>
   state.snapshot.cdn_url!.replace(/\/+$/, "") + "/out/" + o.name + (o.format === "json" ? ".json" : ".rss")

// feedRefs renders an output's feed-id selectors as feed titles (the operator
// picked titles, not numbers), falling back to #id for a since-deleted feed.
function feedRefs(ids?: number[]): string {
   const byId = new Map(state.snapshot.feeds.map((f) => [f.id, f.title]))
   return (ids || []).map((id) => byId.get(id) || "#" + id).join(", ")
}

function renderSyndicate(): void {
   const outs = state.snapshot.out // from the cached snapshot — no store read
   const root = document.getElementById("syndicate")!
   root.replaceChildren(
      el(
         "div",
         { class: "toolbar" },
         el("button", { class: "btn primary", onclick: () => openOutModal(null) }, "+ New output"),
      ),
   )
   if (!outs.length) {
      root.append(
         emptyState(
            "No outputs yet",
            "Publish chosen tags or feeds as a rolling RSS or JSON feed. Writing them needs SRR_CDN_URL set on the fetch loop.",
         ),
      )
      return
   }
   const table = el(
      "table",
      {},
      el(
         "thead",
         {},
         el(
            "tr",
            {},
            el("th", {}, "name"),
            el("th", {}, "format"),
            el("th", {}, "tags"),
            el("th", {}, "feeds"),
            el("th", {}, "limit"),
            el("th", {}, ""),
         ),
      ),
   )
   const tb = el("tbody", {})
   for (const o of outs) {
      // With a CDN URL configured the name links the live out/<name> file the
      // fetch loop writes; without one there is nothing to link (writes skip).
      const name = state.snapshot.cdn_url
         ? el("a", { class: "chip", href: outFileURL(o), target: "_blank", rel: "noopener" }, o.name)
         : el("span", { class: "chip" }, o.name)
      tb.append(
         el(
            "tr",
            {},
            el("td", {}, name),
            el(
               "td",
               {},
               el("span", { class: "chip" }, o.format),
               ...(o.ext ? [" ", el("span", { class: "chip" }, "external")] : []),
            ),
            el("td", {}, (o.tags || []).join(", ")),
            el("td", {}, feedRefs(o.feeds)),
            el("td", {}, String(o.limit || "")),
            el(
               "td",
               { class: "actions" },
               el(
                  "button",
                  { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openOutModal(o) },
                  icon("edit"),
               ),
            ),
         ),
      )
   }
   table.append(tb)
   root.append(table)
}

async function deleteOut(name: string): Promise<boolean> {
   return confirmDelete(`Delete output "${name}"?`, "/api/syndicate/" + encodeURIComponent(name), "Deleted " + name)
}

let outDialog: HTMLDialogElement | undefined
function openOutModal(o: OutFeed | null): void {
   outDialog ||= makeDialog({})
   const dlg = outDialog
   const isEdit = !!o
   const v = o || {
      name: "",
      title: "",
      format: "rss",
      tags: [] as string[],
      feeds: [] as number[],
      limit: 50,
      ext: false,
   }
   const name = el("input", { value: v.name, disabled: isEdit ? "" : null })
   const fmt = el("select", {}, el("option", { value: "rss" }, "rss"), el("option", { value: "json" }, "json"))
   fmt.value = v.format
   const title = el("input", { value: v.title || "" })
   // External outputs are hands-off slots (updated via `srr syndicate push`): the
   // selector/limit rows make no sense and the server rejects them, so the whole
   // block hides while the box is checked.
   const ext = el("input", { type: "checkbox" })
   // Selectors are picked from the snapshot (union of tags ∪ feeds), not typed.
   const [tagsBox, tagSel] = checkList(
      state.snapshot.tags
         .filter((t) => t.tag)
         .map((t) => ({ value: t.tag, label: `${t.tag} (${t.feeds} feed${t.feeds === 1 ? "" : "s"})` })),
      v.tags || [],
   )
   const [feedsBox, feedSel] = checkList(
      state.snapshot.feeds.map((f) => ({ value: f.id, label: f.title })),
      v.feeds || [],
   )
   const limit = el("input", { type: "number", value: String(v.limit || 50) })
   const selWrap = el(
      "div",
      {},
      el("label", {}, "Tags"),
      tagsBox,
      el("label", {}, "Feeds"),
      feedsBox,
      el("label", {}, "Limit"),
      limit,
   )
   ext.addEventListener("change", () => (selWrap.hidden = ext.checked))
   ext.checked = !!v.ext
   selWrap.hidden = ext.checked
   const err = el("div", { class: "formerr" })
   const save = el(
      "button",
      {
         class: "btn primary",
         onclick: async () => {
            const nm = (v.name || name.value).trim()
            const body = ext.checked
               ? { title: title.value.trim(), format: fmt.value, ext: true }
               : {
                    title: title.value.trim(),
                    format: fmt.value,
                    tags: [...tagSel],
                    feeds: [...feedSel],
                    limit: Number(limit.value) || 0,
                 }
            await saveModal(
               dlg,
               err,
               () => api("PUT", "/api/syndicate/" + encodeURIComponent(nm), body),
               "Saved output " + nm,
            )
         },
      },
      "Save",
   )
   dlg.replaceChildren(
      el("h3", {}, isEdit ? "Edit output" : "New output"),
      el("label", {}, "Name"),
      name,
      el("label", {}, "Format"),
      fmt,
      el("label", {}, "Title"),
      title,
      el("label", { class: "check" }, ext, "External — updated via srr syndicate push"),
      selWrap,
      err,
      dialogRow(dlg, save, isEdit ? () => deleteOut(o!.name) : null),
   )
   dlg.showModal()
}

renderers.syndicate = renderSyndicate
