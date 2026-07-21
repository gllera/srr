# Store visibility — public or private, the operator's choice

**Status:** decided 2026-07-20. The current production store (`cdn.llera.eu`) is
**public by explicit choice**.

## The decision

An SRR store may be deployed public or private. SRR supports both; the operator
decides per deployment. This document exists because "public" was previously a
default nobody had chosen — the point of the record is that it is now a
decision, not an accident.

## What a public store exposes

Anyone who can reach the store root can `curl db.gz` and read it. It carries:

- the full subscription list — every feed's title, URL and tag;
- the processing configuration — recipe names, `ingest`/`pipe` overrides,
  retention and dedup settings;
- per-feed fetch health (`ferr`, `fail_streak`, `last_ok`, `last_new`) and the
  byte counters (`cb`/`ab`);
- the syndication slot list (`out`);
- the `head` projection — the titles of the newest articles.

Pack names are also enumerable by construction: the naming grammar is public and
`total_art` tells a reader exactly which finalized packs exist. Article *content*
is therefore readable by anyone who can read `db.gz`.

Nothing here is a credential, and the reader itself is the same data — but a
subscription list is a personal-interest profile, so treat this as "the reading
list is public", not "only the articles are".

## Deploying private

Front the store origin with an auth layer and give the reader credentials for
it. The pieces already exist:

- the **HTTP store backend** carries credential headers (`HTTPConfig.Token`,
  `HTTPConfig.Headers` — e.g. Cloudflare Access service tokens), so the writer
  authenticates;
- the reader's **sync layer** already demonstrates credentialed fetches
  (`credentials: "include"`), and the manifest link uses
  `crossorigin="use-credentials"` for exactly this case;
- the admin GUI is already Access-gated in this deployment
  (`admin-srr.llera.eu`), so the pattern is in production use.

The reader fetches packs with plain `fetch`, so a cookie-based gate (Cloudflare
Access and similar) is the least invasive option: the browser attaches the
session automatically once the user has authenticated to the origin.

## Why the current store stays public

The subscription list and the article titles are not sensitive for this
deployment, and a public origin keeps the CDN path simple (no auth round-trip on
every immutable pack, which is where SRR's cache-forever design pays off). This
is a deliberate acceptance, revisited if the content of the feed list ever
changes character.

## If the stance ever tightens

The leak is dominated by *configuration* riding in the one object every reader
must fetch. Moving the backend-only fields (`recipes`, `out`, `ingest`/`pipe`,
dedup and retention settings) out of `db.gz` into a separate operator-only
object would shrink the public surface to what the reader genuinely needs
(feeds, counts, pointers) without any auth layer at all. That is a strictly
smaller change than going private, and the natural first step.
