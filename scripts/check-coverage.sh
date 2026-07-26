#!/usr/bin/env bash
#
# check-coverage.sh — the backend coverage RATCHET (TST8).
#
# Coverage on this repo used to be checked by hand: someone ran `go test
# -cover`, eyeballed the number, and wrote it into a commit message (3703f41).
# That catches a collapse only if a human happens to look, and it gives a
# rewrite of db_pack.go no signal at all. This script is the machine half: it
# reads a Go coverage profile, aggregates it into the AREAS that actually carry
# risk, and fails when any of them drops below a committed floor.
#
# Usage:  scripts/check-coverage.sh <profile> [floors-file]
#
#   <profile>      a `go test -coverprofile=` file (any covermode)
#   [floors-file]  defaults to scripts/coverage-floors.tsv, next to this script
#
# It is a RATCHET, not a target: the floors sit a little under the measured
# value so unrelated churn cannot red the gate, and raising one is a one-line
# diff in the data file. Nothing here decides what "enough" coverage is — that
# judgement lives in the floors file, with the reasoning next to each number.
#
# How the numbers are computed. A Go profile line is
#   <import-path>/<file>.go:<from>,<to> <numStmt> <count>
# so every area's percentage is STATEMENT-weighted (not file-weighted, not
# function-weighted): covered statements over total statements, exactly what
# `go tool cover -func` prints as its `total:` line. An area is a POSIX ERE
# matched against the path part, so areas may overlap freely and a file counted
# in `db` is still counted in the total.
#
# BLOCKS ARE DEDUPLICATED, and that is load-bearing rather than tidy. Under Go's
# coverage redesign, `go test -coverprofile ./...` emits counters for every
# INSTRUMENTED package linked into each test binary — so with srr, srr/store,
# srr/mod and srr/ingest all under test in one invocation, srv/store's blocks
# land in the profile once per binary that imports it. Worse, whether they do
# depends on which packages the build cache replayed, so the same tree measured
# 80.4% of 683 statements on one run and 80.4% of 2049 on the next. Summing
# naively is therefore not merely triple-counting; it is triple-counting that
# comes and goes. This script keys each block on its full path:line.col span and
# ORs the hit flag across occurrences, which is what `go tool cover` does and
# what makes the reported number a property of the tree instead of the cache.
#
# One caveat worth stating, because it bounds what the floors can mean:
# `go test -coverprofile ./...` instruments each package against its OWN tests
# only. srr/store's percentage is what store's tests cover, NOT what the whole
# suite exercises through it. That is the conservative reading and the useful
# one for a ratchet — it cannot be inflated by an integration test that merely
# walks through a package.
#
# THE FLOORS FILE IS PARSED STRICTLY, for the same reason an area matching no
# path is a FAIL rather than a pass. A row that is not exactly three columns, or
# whose floor column is not a number, exits 2 — it is not skipped. A skipped row
# retires that area's gate leaving no trace in the report, and a floor coerced
# from a non-number to 0 passes anything. Blank and comment-only lines stay
# legal; everything else must parse.

set -euo pipefail

profile=${1:?usage: check-coverage.sh <profile> [floors-file]}
floors=${2:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/coverage-floors.tsv"}

[ -f "$profile" ] || { echo "check-coverage: no such profile: $profile" >&2; exit 2; }
[ -f "$floors" ] || { echo "check-coverage: no such floors file: $floors" >&2; exit 2; }

awk -v floorfile="$floors" '
# ---- pass 1: the floors file (area <TAB|space> pattern <TAB|space> floor) ----
BEGIN {
  n = 0
  while ((getline line < floorfile) > 0) {
    sub(/#.*/, "", line)                       # strip comments
    gsub(/^[ \t]+|[ \t]+$/, "", line)          # and surrounding whitespace
    if (line == "") continue                   # blank / comment-only: legal
    # A MALFORMED row is not a blank one. Skipping it would silently retire the
    # gate for that area — the same vacuity the no-match check below guards
    # against, and invisible in the report because the row simply is not there.
    # `!= 3` also catches a stray fourth column, which would otherwise be lost.
    if (split(line, f, /[ \t]+/) != 3) {
      print "check-coverage: malformed floors row (want 3 columns): " line > "/dev/stderr"
      exit 2
    }
    # And a non-numeric floor must not coerce to 0, which passes everything.
    if (f[3] !~ /^[0-9]+(\.[0-9]+)?$/) {
      print "check-coverage: non-numeric floor \"" f[3] "\" for area " f[1] > "/dev/stderr"
      exit 2
    }
    n++; area[n] = f[1]; pat[n] = f[2]; floor[n] = f[3] + 0
    if (length(area[n]) > width) width = length(area[n])
  }
  close(floorfile)
  if (n == 0) { print "check-coverage: floors file defines no areas" > "/dev/stderr"; exit 2 }
  if (width < 4) width = 4
}

# ---- pass 2: the profile, one entry per unique block (see the header) ----
# Skip the mode header and anything that is not a <path> <stmts> <count> triple.
/^mode:/ { next }
NF != 3 { next }
{
  size[$1] = $2 + 0
  if (($3 + 0) > 0) hit[$1] = 1
}

END {
  for (blk in size) {
    stmts = size[blk]; got = (blk in hit) ? stmts : 0
    total_stmts += stmts; total_hit += got

    path = blk; sub(/:[0-9]+\.[0-9]+,[0-9]+\.[0-9]+$/, "", path)
    # Memoize the area membership per PATH: a file contributes hundreds of
    # blocks and the regex answer is the same for every one of them.
    if (!(path in memo)) {
      m = ""
      for (i = 1; i <= n; i++) if (path ~ pat[i]) m = m i " "
      memo[path] = m
    }
    k = split(memo[path], hits, " ")
    for (j = 1; j <= k; j++) { tot[hits[j] + 0] += stmts; cov[hits[j] + 0] += got }
  }

  if (total_stmts == 0) { print "check-coverage: profile holds no statements" > "/dev/stderr"; exit 2 }
  printf "%-*s  %8s  %7s  %7s  %8s\n", width, "area", "stmts", "actual", "floor", "delta"
  fail = 0
  for (i = 1; i <= n; i++) {
    # An area matching nothing is a BROKEN PATTERN, not a pass: a renamed file
    # would otherwise silently retire its own floor.
    if (tot[i] == 0) {
      printf "%-*s  %8s  %7s  %7.1f  %8s\n", width, area[i], "-", "no match", floor[i], "FAIL"
      fail = 1; continue
    }
    pct = 100 * cov[i] / tot[i]; d = pct - floor[i]
    printf "%-*s  %8d  %6.1f%%  %6.1f%%  %+7.1f%s\n", width, area[i], tot[i], pct, floor[i], d,
           (d < 0 ? "  FAIL" : "")
    if (d < 0) fail = 1
  }
  printf "\n%d of %d statements covered overall (%.1f%%)\n", total_hit, total_stmts, 100 * total_hit / total_stmts
  if (fail) {
    print "\ncoverage below floor — add tests, or lower the floor in the data file and say why" > "/dev/stderr"
    exit 1
  }
  print "every area is at or above its floor"
}
' "$profile"
