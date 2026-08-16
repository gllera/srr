// Shared modal + form primitives, ported from app.js. The one behavioral change
// (SEC3): confirmDelete's native window.confirm becomes confirmDialog, a
// <dialog>-based prompt in the console's own design system.

import { api } from "./api"
import { banner } from "./banner"
import { el, iconBtn } from "./dom"
import { refresh } from "./store"
import type { Recipe } from "./types"

export function makeDialog(attrs: Record<string, unknown>): HTMLDialogElement {
   const d = el("dialog", attrs)
   document.body.append(d)
   return d
}

// A tab's data table from its header row and its body rows. Every tab wrote the
// table → thead → tr → tbody nesting out by hand, so a fourth re-typed it and
// the structure was re-verified three times. A string header becomes a plain
// <th>; an element (feeds.ts's sortableTh) rides as-is.
export function dataTable(headers: (string | HTMLElement)[], rows: HTMLElement[]): HTMLTableElement {
   const table = el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ...headers.map((h) => (typeof h === "string" ? el("th", {}, h) : h)))),
   )
   table.append(el("tbody", {}, ...rows))
   return table
}

// The console's <dialog>s are built on first open and reused forever after,
// because makeDialog APPENDS unconditionally — a modal opened without the lazy
// guard leaks a <dialog> into the body per open. Five call sites each wrote that
// guard as a module-level `let` plus a `||=`; this is the same thing with the
// rule inside it, so a sixth modal cannot be written without it. The reader half
// solved this the same way (dropdown.ts's lazyDialog); admin can't import it,
// which is what the module boundary here is for.
export function lazyDialog(attrs: Record<string, unknown>): () => HTMLDialogElement {
   let d: HTMLDialogElement | undefined
   return () => (d ??= makeDialog(attrs))
}

// confirmDialog replaces native window.confirm with a modal in the console's
// voice (SEC3 named confirmDelete's window.confirm). Resolves true on confirm,
// false on Cancel / Escape / backdrop.
export function confirmDialog(question: string): Promise<boolean> {
   return new Promise((resolve) => {
      const dlg = makeDialog({ class: "confirm-dialog" })
      let settled = false
      const done = (ok: boolean) => {
         if (settled) return
         settled = true
         dlg.close()
         dlg.remove()
         resolve(ok)
      }
      dlg.addEventListener("cancel", () => done(false)) // Escape
      const confirmBtn = el("button", { class: "btn danger", onclick: () => done(true) }, "Delete")
      dlg.replaceChildren(
         el("p", { class: "confirm-msg" }, question),
         el("div", { class: "row" }, el("button", { class: "btn", onclick: () => done(false) }, "Cancel"), confirmBtn),
      )
      dlg.showModal()
      confirmBtn.focus()
   })
}

// confirmDelete is the shared confirm → DELETE → banner → refresh flow used by
// every tab's delete action; refresh() re-pulls the snapshot after the delete.
export async function confirmDelete(question: string, url: string, successMsg: string): Promise<boolean> {
   if (!(await confirmDialog(question))) return false
   try {
      await api("DELETE", url)
      banner(successMsg, true)
      await refresh()
      return true
   } catch (e) {
      banner((e as Error).message)
      return false
   }
}

// saveModal is the shared try/refresh/close/banner/catch boilerplate for every
// modal save button. Validation and request-body building stay in the caller.
export async function saveModal(
   dlg: HTMLDialogElement,
   errBox: HTMLElement,
   doApi: () => Promise<unknown>,
   okMsg: string,
): Promise<void> {
   try {
      await doApi()
      await refresh()
      dlg.close()
      banner(okMsg, true)
   } catch (e) {
      errBox.textContent = (e as Error).message
   }
}

// appendRecipeOptions fills a <select> with recipe-name options from the given
// recipes map (skipping the implicit "default"), marking `selected` chosen.
export function appendRecipeOptions(sel: HTMLSelectElement, selected: string, recipes: Record<string, Recipe>): void {
   for (const n of Object.keys(recipes).sort()) {
      if (n === "default") continue
      const o = el("option", { value: n }, n)
      if (n === selected) o.selected = true
      sel.append(o)
   }
}

// dialogRow builds the modal footer: Cancel + Save on the right, plus — when an
// onDelete is given (edit of an existing, deletable item) — a Delete button on
// the left. onDelete resolves truthy on a confirmed delete, then the dialog closes.
export function dialogRow(
   dlg: HTMLDialogElement,
   saveBtn: HTMLElement,
   onDelete?: (() => Promise<boolean>) | null,
): HTMLElement {
   const kids: Node[] = []
   if (onDelete) {
      kids.push(
         el(
            "button",
            {
               class: "btn danger delete-left",
               onclick: async () => {
                  if (await onDelete()) dlg.close()
               },
            },
            "Delete",
         ),
      )
   }
   kids.push(el("button", { class: "btn", onclick: () => dlg.close() }, "Cancel"), saveBtn)
   return el("div", { class: "row" }, ...kids)
}

interface StepsOpts {
   placeholder?: string
   emptyNote?: string
   hint?: string
}

// stepsEditor renders an editable pipeline-step list (one input per step,
// remove buttons, "+ step") into the returned box, mutating `steps` in place.
// Shared by the recipe modal and the feed modal's feed-level pipe override.
export function stepsEditor(steps: string[], opts?: StepsOpts): HTMLElement {
   const o = opts || {}
   const box = el("div", { class: "steps" })
   function draw(): void {
      box.replaceChildren()
      steps.forEach((s, i) => {
         const inp = el("input", {
            value: s,
            placeholder: o.placeholder || null,
            oninput: (e: Event) => (steps[i] = (e.target as HTMLInputElement).value),
         })
         box.append(
            el(
               "div",
               { class: "step" },
               inp,
               iconBtn("delete", "Remove step", () => {
                  steps.splice(i, 1)
                  draw()
               }),
            ),
         )
      })
      const addBtn = el(
         "button",
         {
            class: "btn",
            onclick: () => {
               steps.push("")
               draw()
               // NOT `.step:last-of-type`: draw() appends the N step rows and
               // then a `div.foot`, and :last-of-type keys on the TAG, so no
               // element is ever both `.step` and the last <div> — the selector
               // matched nothing and the `!` threw on every click. The step was
               // still added (draw already ran), which is why only the focus was
               // missing and nobody noticed.
               const inputs = box.querySelectorAll<HTMLInputElement>(".step input")
               inputs[inputs.length - 1]?.focus()
            },
         },
         "+ step",
      )
      box.append(
         el(
            "div",
            { class: "foot" },
            addBtn,
            !steps.length && o.emptyNote ? el("span", { class: "muted" }, o.emptyNote) : "",
         ),
      )
      if (steps.length && o.hint) box.append(el("p", { class: "hint" }, o.hint))
   }
   draw()
   return box
}

// checkList renders a scrollable checkbox list and returns [element, selected
// Set]. Selection lives in the Set; the caller reads it at save time.
export function checkList<T>(items: { value: T; label: string }[], initial: T[]): [HTMLElement, Set<T>] {
   const sel = new Set<T>(initial)
   const box = el("div", { class: "picker" })
   if (!items.length) box.append(el("div", { class: "muted" }, "none available"))
   for (const it of items) {
      const cb = el("input", {
         type: "checkbox",
         onchange: () => (cb.checked ? sel.add(it.value) : sel.delete(it.value)),
      })
      cb.checked = sel.has(it.value)
      box.append(el("label", { class: "check" }, cb, it.label))
   }
   return [box, sel]
}

// emptyState is the shared directed empty panel — a wire eyebrow over a one-line
// invitation, matching the reader's empty-state voice.
export function emptyState(eyebrow: string, msg: string): HTMLElement {
   return el(
      "div",
      { class: "empty" },
      el("div", { class: "empty-eyebrow" }, eyebrow),
      el("div", { class: "empty-msg" }, msg),
   )
}

// pipeTokens renders a recipe's pipe steps as connected wire tokens (mono chips
// joined by → arrows); a built-in #mod gets the signal tint. Empty pipe → em dash.
export function pipeTokens(pipe?: string[]): HTMLElement {
   const steps = pipe || []
   if (!steps.length) return el("span", { class: "muted" }, "—")
   const kids: Node[] = []
   steps.forEach((s, i) => {
      if (i) kids.push(el("span", { class: "arrow" }, "→"))
      kids.push(el("span", { class: "tok" + (s.startsWith("#") ? " builtin" : "") }, s))
   })
   return el("div", { class: "pipe" }, ...kids)
}

// overrideChip marks a feed carrying feed-level {ingest, pipe, secrets} overrides
// on top of its recipe; the tooltip says which axis. Empty string (renders as
// nothing) when the feed has none — the common case. The three axes are the same
// ones feeds.ts's advValues() enumerates behind the Advanced fold: a feed whose
// only override is its secret grant (SEC5) must still wear the badge, or saved
// config hides silently in the table.
export function overrideChip(f: { ingest?: string; pipe?: string[]; secrets?: string[] }): HTMLElement | string {
   const axes = [f.ingest && "ingest", (f.pipe || []).length && "pipe", (f.secrets || []).length && "secrets"].filter(
      Boolean,
   )
   if (!axes.length) return ""
   return el("span", { class: "chip recipe", title: "feed-level " + axes.join(" + ") + " override" }, "override")
}

// splitScopes parses a comma/space-separated secret-scope input into the
// string[] the API takes — trimmed, empties dropped. Shared by the feed and
// recipe modals (both bodies are full-replace, so the field always ships).
export function splitScopes(value: string): string[] {
   return value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
}
