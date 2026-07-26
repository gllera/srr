#!/usr/bin/env bash
#
# check-coverage.test.sh — the ratchet's own test.
#
# check-coverage.sh is a gate, and a gate that cannot fail is worse than no gate:
# it reports "every area is at or above its floor" over nothing at all. Its four
# anti-vacuity properties live in one awk program that nothing exercised —
# deleting any of them left `make cover-be` green:
#
#   1. an area whose pattern matches NO path FAILS (a renamed file must not
#      silently retire its own floor)
#   2. a profile holding no statements EXITS 2 (an empty or header-only profile
#      is a broken measurement, not full coverage)
#   3. blocks are DEDUPLICATED by their path:line.col span, so the percentage is
#      a property of the tree rather than of which packages the build cache
#      replayed
#   4. the FLOORS side is parsed strictly: a row that is not three columns, or
#      whose floor is not a number, EXITS 2 rather than being skipped (skipped
#      == that area is no longer gated) or coerced to a floor of 0 (== passes
#      everything). Properties 1-3 were all on the PROFILE side; the floors
#      parser could degrade with nothing noticing.
#
# Plus the ordinary ones: below-floor fails, at-floor passes.
#
# Usage: scripts/check-coverage.test.sh   (no arguments; exits non-zero on
# the first failing case, printing what it expected)

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/check-coverage.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fails=0

# run <profile-contents> <floors-contents> -> sets $out and $rc
run() {
   printf '%s\n' "$1" > "$work/profile"
   printf '%s\n' "$2" > "$work/floors"
   set +e
   out=$("$script" "$work/profile" "$work/floors" 2>&1)
   rc=$?
   set -e
}

check() { # check <name> <want-rc> [<substring the output must contain>]
   local name=$1 want=$2 needle=${3:-}
   if [ "$rc" != "$want" ]; then
      echo "FAIL: $name — exit $rc, want $want"
      echo "$out" | sed 's/^/    /'
      fails=$((fails + 1))
      return
   fi
   if [ -n "$needle" ] && ! grep -qF -- "$needle" <<< "$out"; then
      echo "FAIL: $name — output does not mention '$needle'"
      echo "$out" | sed 's/^/    /'
      fails=$((fails + 1))
      return
   fi
   echo "ok: $name"
}

# A profile with 4 statements, 3 of them covered => 75%.
PROFILE='mode: set
srr/a.go:1.1,2.2 2 1
srr/a.go:3.1,4.2 1 1
srr/a.go:5.1,6.2 1 0'

# --- the ordinary directions -----------------------------------------------

run "$PROFILE" 'a	^srr/a	70.0'
check "above floor passes" 0 "every area is at or above its floor"

run "$PROFILE" 'a	^srr/a	80.0'
check "below floor fails" 1 "coverage below floor"

run "$PROFILE" 'a	^srr/a	75.0'
check "exactly at floor passes" 0 "every area is at or above its floor"

# --- anti-vacuity 1: an area matching nothing is a FAIL, not a pass ---------

run "$PROFILE" 'gone	^srr/renamed	10.0'
check "an area matching no path fails" 1 "no match"

# It must fail even when a sibling area is healthy — i.e. the whole run reds,
# rather than the broken pattern being lost among passing rows.
run "$PROFILE" 'a	^srr/a	70.0
gone	^srr/renamed	10.0'
check "one broken pattern reds the whole run" 1 "no match"

# --- anti-vacuity 2: an empty measurement is an ERROR, not 100% -------------

run 'mode: set' 'a	^srr/a	70.0'
check "a header-only profile exits 2" 2 "no statements"

run '' 'a	^srr/a	70.0'
check "an empty profile exits 2" 2 "no statements"

# A floors file that defines no areas is equally a broken measurement.
run "$PROFILE" '# only a comment'
check "a floors file with no areas exits 2" 2 "no areas"

# --- anti-vacuity 3: blocks are deduplicated by span ------------------------
#
# `go test -coverprofile ./...` emits a package's counters once per test binary
# that links it, and WHICH binaries get replayed depends on the build cache. So
# the same tree measured 683 statements on one run and 2049 on the next. If the
# script summed naively, the duplicated profile below would report a different
# statement count from the plain one — and the floors would drift with the cache.

run "$PROFILE" 'a	^srr/a	70.0'
plain=$(grep -o '[0-9]* of [0-9]* statements covered' <<< "$out")

DUPED="$PROFILE
srr/a.go:1.1,2.2 2 1
srr/a.go:3.1,4.2 1 1
srr/a.go:5.1,6.2 1 0"
run "$DUPED" 'a	^srr/a	70.0'
duped=$(grep -o '[0-9]* of [0-9]* statements covered' <<< "$out")

if [ "$plain" = "$duped" ]; then
   echo "ok: duplicated blocks are counted once ($plain)"
else
   echo "FAIL: duplicated blocks changed the count — '$plain' vs '$duped'"
   fails=$((fails + 1))
fi

# The dedup ORs the hit flag rather than taking the last occurrence: the same
# block instrumented in two binaries may be exercised in only one of them.
run "mode: set
srr/a.go:1.1,2.2 1 1
srr/a.go:1.1,2.2 1 0" 'a	^srr/a	100.0'
check "a block hit in any binary counts as covered" 0 "every area is at or above its floor"

# --- anti-vacuity 4: the FLOORS side --------------------------------------
#
# 1-3 all live on the PROFILE side. The floors PARSER can degrade just as
# vacuously and even more quietly: it is the thing that decides which areas are
# gated at all. A row that loses its floor column used to be indistinguishable
# from a blank line — skipped, no error — so a mangled row RETIRED that area's
# gate and the report simply had one fewer line in it. And a floor that is not a
# number used to be coerced by `+ 0` to 0.0, which every measurement clears.

run "$PROFILE" 'a	^srr/a'
check "a floors row missing its floor exits 2" 2 "malformed floors row"

# It must be caught even behind a well-formed row — the mangled row must not be
# lost among healthy ones, exactly as with a broken pattern.
run "$PROFILE" 'a	^srr/a	70.0
b	^srr/b'
check "a malformed row behind a healthy one exits 2" 2 "malformed floors row"

# A stray fourth column is malformed too: it used to be silently ignored, and
# the thing most likely to produce one is an unmarked comment on the row.
run "$PROFILE" 'a	^srr/a	70.0	oops'
check "a floors row with a fourth column exits 2" 2 "malformed floors row"

# The floor must be a NUMBER. Use a genuinely non-numeric token: awk parses
# "84.O" as 84, so a test written with that would pass with the guard removed
# and therefore assert nothing.
run "$PROFILE" 'a	^srr/a	seventy'
check "a word where the floor belongs exits 2" 2 "non-numeric floor"

# The realistic typo — a letter O for a zero — which without the guard coerces
# to 0.0 and silently passes every measurement.
run "$PROFILE" 'a	^srr/a	O84'
check "a floor that coerces to 0 exits 2" 2 "non-numeric floor"

# The strictness must stop at rows that carry data: blanks, comment-only lines
# and trailing row comments are how the real floors file is written, so they
# stay legal. (A decimal floor is the normal case and must survive the regex.)
run "$PROFILE" '# the floors
a	^srr/a	70.5  # a trailing note

# another comment
'
check "blanks, comments and a decimal floor stay legal" 0 "every area is at or above its floor"

# --- argument handling ------------------------------------------------------

set +e
out=$("$script" "$work/nope" "$work/floors" 2>&1); rc=$?
set -e
check "a missing profile exits 2" 2 "no such profile"

set +e
out=$("$script" "$work/profile" "$work/nope" 2>&1); rc=$?
set -e
check "a missing floors file exits 2" 2 "no such floors"

if [ "$fails" -ne 0 ]; then
   echo
   echo "$fails check-coverage assertion(s) failed"
   exit 1
fi
echo
echo "check-coverage.sh: all assertions passed"
