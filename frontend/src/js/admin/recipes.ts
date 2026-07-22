// The Recipes tab: the recipe table, the create/edit recipe modal, and the
// "preview a recipe against a URL" panel (whose state persists across tab
// switches via previewState). Ported from app.js's recipes section.

import { api } from "./api"
import { el, icon } from "./dom"
import { renderers, state } from "./store"
import { previewState, renderPreviewInto } from "./preview"
import { appendRecipeOptions, confirmDelete, dialogRow, makeDialog, pipeTokens, saveModal, stepsEditor } from "./ui"
import type { Recipe } from "./types"

function renderRecipes(): void {
   const recipes = state.snapshot.recipes // from the cached snapshot — no store read
   const root = document.getElementById("recipes")!
   root.replaceChildren()
   root.append(
      el(
         "div",
         { class: "toolbar" },
         el("button", { class: "btn primary", onclick: () => openRecipeModal(null, null) }, "+ New recipe"),
      ),
   )

   const table = el(
      "table",
      {},
      el(
         "thead",
         {},
         el("tr", {}, el("th", {}, "name"), el("th", {}, "ingest"), el("th", {}, "pipe"), el("th", {}, "")),
      ),
   )
   const tb = el("tbody", {})
   for (const name of Object.keys(recipes).sort()) {
      const rcp = recipes[name]
      const actions = el(
         "td",
         { class: "actions" },
         el(
            "button",
            { class: "btn icon", title: "Edit", "aria-label": "Edit", onclick: () => openRecipeModal(name, rcp) },
            icon("edit"),
         ),
      )
      tb.append(
         el(
            "tr",
            {},
            el("td", {}, el("span", { class: "chip" }, name)),
            el(
               "td",
               {},
               rcp.ingest ? el("span", { class: "chip" }, rcp.ingest) : el("span", { class: "muted" }, "#feed"),
            ),
            el("td", {}, pipeTokens(rcp.pipe)),
            actions,
         ),
      )
   }
   table.append(tb)
   root.append(table)
   root.append(previewPanel(recipes))
}

async function deleteRecipe(name: string): Promise<boolean> {
   return confirmDelete(
      `Delete recipe "${name}"?`,
      "/api/recipes/" + encodeURIComponent(name),
      "Deleted recipe " + name,
   )
}

let recipeDialog: HTMLDialogElement | undefined
function openRecipeModal(name: string | null, rcp: Recipe | null): void {
   recipeDialog ||= makeDialog({})
   const dlg = recipeDialog
   const isEdit = !!name
   const nameIn = el("input", { value: name || "", disabled: isEdit ? "" : null })
   const ingestIn = el("input", { value: (rcp && rcp.ingest) || "", placeholder: "#feed (default)" })
   const steps = rcp && rcp.pipe ? [...rcp.pipe] : []
   const stepsBox = stepsEditor(steps, {
      placeholder: "#sanitize or a shell command",
      emptyNote:
         name === "default" ? "no steps — articles pass through unchanged" : "inherits the default recipe's pipe",
   })
   const err = el("div", { class: "formerr" })

   const save = el(
      "button",
      {
         class: "btn primary",
         onclick: async () => {
            err.textContent = ""
            const nm = (name || nameIn.value).trim()
            if (!nm) {
               err.textContent = "name required"
               return
            }
            const body = { ingest: ingestIn.value.trim(), pipe: steps.map((s) => s.trim()).filter(Boolean) }
            await saveModal(
               dlg,
               err,
               () => api("PUT", "/api/recipes/" + encodeURIComponent(nm), body),
               (isEdit ? "Updated " : "Created ") + "recipe " + nm,
            )
         },
      },
      "Save",
   )

   dlg.replaceChildren(
      el("h3", {}, isEdit ? "Edit recipe" : "New recipe"),
      el("label", {}, "Name"),
      nameIn,
      el("label", {}, "Ingest (blank = inherit default)"),
      ingestIn,
      el("label", {}, "Pipe steps"),
      stepsBox,
      err,
      dialogRow(dlg, save, isEdit && name !== "default" ? () => deleteRecipe(name!) : null),
   )
   dlg.showModal()
}

function previewPanel(recipes: Record<string, Recipe>): HTMLElement {
   const url = el("input", {
      type: "url",
      class: "preview-url",
      placeholder: "https://example.com/feed",
      value: previewState.url,
      oninput: (e: Event) => (previewState.url = (e.target as HTMLInputElement).value),
   })
   const recipeSel = el(
      "select",
      { onchange: (e: Event) => (previewState.recipe = (e.target as HTMLSelectElement).value) },
      el("option", { value: "default" }, "default"),
   )
   appendRecipeOptions(recipeSel, previewState.recipe, recipes)
   const out = el("div", {})
   const go = el(
      "button",
      { class: "btn", onclick: () => renderPreviewInto(out, url.value, recipeSel.value) },
      "Preview",
   )
   return el(
      "div",
      { class: "preview-panel" },
      el("h3", { class: "section-head" }, "Preview a recipe against a URL"),
      el("div", { class: "toolbar" }, url, recipeSel, go),
      out,
   )
}

renderers.recipes = renderRecipes
