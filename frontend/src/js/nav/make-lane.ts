// nav/make-lane.ts — the ONE place a token list becomes a lane. It lives apart
// from lane.ts so the interface and its implementations never import each other.
import { readSeen } from "../seen"
import { classifyTokens, isWatchKey, type Lane, type LaneEnv } from "./lane"
import { isKnownToken, MembersLane, resolveMembership } from "./lane-members"
import { SavedLane } from "./lane-saved"
import { SearchLane } from "./lane-search"
import { WatchLane } from "./lane-watch"

// `keepKnownEmpty`: applyFilter and switchFilter keep a KNOWN feed/tag with no
// articles scoped to itself — an empty lane under its own token, so a reload or
// back to `#!<token>` shows its empty state — while fromHash and a bare
// `filter.set` fall back to [ALL] like any unresolved token.
export function makeLane(tokens: readonly string[], env: LaneEnv, opts: { keepKnownEmpty?: boolean } = {}): Lane {
   const c = classifyTokens(tokens)
   if (c.kind === "saved") return new SavedLane(tokens)
   if (c.kind === "search") return new SearchLane(tokens, c.q, env)
   // A rule the store no longer lists is an unknown token like any other: it falls
   // through to membership resolution, which finds nothing and lands on [ALL].
   if (c.kind === "watch" && isWatchKey(tokens[0])) return new WatchLane(tokens, c.rule)
   if (tokens.length > 0) {
      const members = resolveMembership(tokens)
      if (members.size > 0) return withUnseen(new MembersLane(tokens, members, env))
      if (opts.keepKnownEmpty && tokens.length === 1 && isKnownToken(tokens[0]))
         return new MembersLane(tokens, new Map(), env)
   }
   return withUnseen(new MembersLane([], resolveMembership([]), env))
}

// Fold unread-only into a just-built membership (applyUnseen is a no-op unless on).
function withUnseen(lane: MembersLane): MembersLane {
   lane.applyUnseen(readSeen())
   return lane
}
