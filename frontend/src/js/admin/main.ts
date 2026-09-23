// The admin console entry. Import the four tabs for their renderer-registration
// side effects (each does `renderers.<tab> = draw<Tab>` at load), then wire the
// banner + tab router and boot the single-read snapshot model.

import { bindBanner } from "./banner"
import { refuseIfFramed } from "./frame"
import { boot, wireTabRouter } from "./store"

import "./feeds"
import "./recipes"
import "./syndicate"
import "./tools"

if (!refuseIfFramed(window, document.body)) {
   bindBanner()
   wireTabRouter()
   void boot()
}
