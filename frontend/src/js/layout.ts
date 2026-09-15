// layout.ts — the LAYOUT RECORD. Every "is the list on screen / is the reader on
// screen / is the reader live / which pane has the keyboard" question is answered
// here, from five model inputs, and ONE effect writes the answer to the DOM.
//
// It exists because `view` (which surface has focus) kept being asked a
// VISIBILITY question: under split both panes are on screen whatever has focus,
// and the split-view bug rounds found one `view ===` site at a time. The record
// makes the right question the only one on offer — focus survives as a field,
// and the sites allowed to read it are listed in docs/ARCHITECTURE.md.
//
// Imports model + signals only.
import * as model from "./model"
import { computed, effect, shallowEqual } from "./signals"

export interface LayoutInputs {
   split: boolean
   focus: model.Focus
   paneHidden: boolean
   readerPainted: boolean
   cursorChron: number
}

export interface Layout {
   split: boolean // ≥1000px
   focus: model.Focus // which pane owns the keyboard — never a visibility answer
   paneHidden: boolean // the L key / the grip / the toggle (stamped at any width)
   listMounted: boolean // the list is laid out and may repaint (a hidden pane counts)
   listShown: boolean // the list is on screen
   readerMounted: boolean // the reader host is laid out
   readerLive: boolean // an article is painted AND the cursor names one
   readerSteppable: boolean // ←/→ act on the reader (overlay gates stay in app.ts)
   listKeys: boolean // the list's own row stepping owns ←/→
}

// Pure, total over every input: single-surface mode is just the case where
// listMounted === !readerMounted.
export function deriveLayout(i: LayoutInputs): Layout {
   const listMounted = i.split || i.focus === "list"
   const readerMounted = i.split || i.focus === "reader"
   const readerLive = readerMounted && i.readerPainted && i.cursorChron >= 0
   return {
      split: i.split,
      focus: i.focus,
      paneHidden: i.paneHidden,
      listMounted,
      listShown: listMounted && !(i.split && i.paneHidden),
      readerMounted,
      readerLive,
      readerSteppable: i.focus === "reader" || readerLive,
      listKeys: i.focus === "list" && !readerLive,
   }
}

// shallowEqual: an input that moves without changing any field (a cursor step
// while nothing is painted) must not re-run the effects that read the record.
export const layout: () => Layout = computed(
   () =>
      deriveLayout({
         split: model.split(),
         focus: model.focus(),
         paneHidden: model.paneHidden(),
         readerPainted: model.readerPainted(),
         cursorChron: model.cursor().chron,
      }),
   shallowEqual,
)

export interface LayoutHosts {
   listView: HTMLElement
   article: HTMLElement
}

// The whole DOM contract of the layout. The ONLY writer of these five body
// classes and of the two hosts' `hidden` (split.ts's print crossing toggles
// srr-split alone, deliberately). srr-view-list stays for the CSS and the
// browser suites that key on it; srr-list-shown / srr-reader-shown are stamped
// for a later selector migration.
export function applyLayout(l: Layout, hosts: LayoutHosts): void {
   const body = document.body.classList
   body.toggle("srr-split", l.split)
   body.toggle("srr-pane-hidden", l.paneHidden)
   body.toggle("srr-view-list", l.focus === "list")
   body.toggle("srr-list-shown", l.listShown)
   body.toggle("srr-reader-shown", l.readerMounted)
   hosts.listView.hidden = !l.listMounted
   hosts.article.hidden = !l.readerMounted
}

export function initLayout(hosts: LayoutHosts): () => void {
   return effect(() => applyLayout(layout(), hosts))
}
