// design-boot.ts — the single module entry for design.html. Importing app boots
// the REAL app (app.ts self-runs on import); importing design mounts the harness
// control panel on srr:ready. One entry script keeps Parcel from hoisting a
// shared bundle that would evaluate base.ts before the build-time SRR_CDN_URL
// injection (two module scripts on the page triggered that → ReferenceError).
// design.ts itself stays app-free so the unit tests can import it in isolation.
import "./app"
import "./design"
