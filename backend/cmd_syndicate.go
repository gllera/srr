package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"strings"

	"srr/store"
)

// outNameRe is the allowlist for syndication output feed names: one or more
// alphanumeric, dot, underscore, or hyphen characters. "." and ".." are
// explicitly rejected after the regex check so names like "." never escape
// the out/ prefix via path.Join / filepath.Join.
var outNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// validOutName reports whether name is a safe syndication output feed name:
// it must match outNameRe and must not be "." or "..".
func validOutName(name string) bool {
	return outNameRe.MatchString(name) && name != "." && name != ".."
}

// outDefaultLimit is the default item count for a syndication output feed when
// the caller does not specify --limit (or specifies 0).
const outDefaultLimit = 50

// SyndicateGroup holds the `srr syndicate` sub-commands.
type SyndicateGroup struct {
	Ls    SyndicateLsCmd    `cmd:"" help:"List syndication output feeds."`
	Set   SyndicateSetCmd   `cmd:"" help:"Add or update a syndication output feed."`
	Rm    SyndicateRmCmd    `cmd:"" help:"Remove a syndication output feed and delete its out/* files."`
	Push  SyndicatePushCmd  `cmd:"" help:"Publish an external syndication output from a file or stdin."`
	Fetch SyndicateFetchCmd `cmd:"" help:"Print a syndication output's currently published file to stdout."`
}

// SyndicateLsCmd prints the current Out list as JSON.
type SyndicateLsCmd struct {
	// Same -f contract as `feed ls` / `feed show`, so every record-listing verb
	// answers to one flag.
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *SyndicateLsCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		return printFormatted(o.Format, db.core.Out)
	})
}

// SyndicateSetCmd adds or updates a named syndication output feed.
type SyndicateSetCmd struct {
	Name     string   `arg:"" help:"Output feed name (used as the file stem: out/<name>.rss or out/<name>.json)."`
	Format   string   `short:"f" required:"" help:"Output format: rss (RSS 2.0) or json (JSON Feed 1.1)."`
	Title    string   `short:"t" help:"Channel/feed title (defaults to name when empty)."`
	Tags     []string `short:"g" sep:"," help:"Tag filter: include articles from feeds whose tag is in this list (comma-separated)."`
	FeedIDs  []int    `short:"i" sep:"," help:"Feed id filter: include articles from these specific feed ids (comma-separated)."`
	Limit    int      `short:"l" default:"0" help:"Maximum number of items to include (newest first; default 50)."`
	External bool     `short:"x" help:"Externally-updated output: SRR reserves the slot but never generates its bytes. Publish with 'srr syndicate push', read back with 'srr syndicate fetch'. Takes no tags/feeds/limit."`
}

func (o *SyndicateSetCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return setOutFeed(ctx, db, OutFeed{
			Name:     o.Name,
			Title:    o.Title,
			Format:   o.Format,
			Tags:     o.Tags,
			Feeds:    o.FeedIDs,
			Limit:    o.Limit,
			External: o.External,
		})
	})
}

// SyndicateRmCmd removes a named syndication output feed and best-effort
// deletes its out/* files (silent-on-missing).
type SyndicateRmCmd struct {
	Name string `arg:"" help:"Output feed name to remove."`
}

func (o *SyndicateRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return removeOutFeed(ctx, db, o.Name)
	})
}

// maxOutPayload caps a pushed syndication payload (64 MiB, consistent with
// the subprocess-stdout and frontend-download caps). A var, not a const:
// tests shrink it to exercise the rejection without a 64 MiB buffer.
var maxOutPayload int64 = 64 << 20

// SyndicatePushCmd publishes an external syndication output: payload from a
// file (or stdin), validated for well-formedness, written with the exact
// header discipline SyncOutFeeds uses. Lock-free: db.gz is read, never
// written, so a push never contends with a running fetch cycle.
type SyndicatePushCmd struct {
	Name string `arg:"" help:"Output feed name (must be declared with --external)."`
	Path string `arg:"" optional:"" default:"-" help:"Payload file; '-' (the default) reads stdin."`

	in io.Reader // test seam; defaults to os.Stdin
}

func (o *SyndicatePushCmd) Run() error {
	return withDB(false, func(ctx context.Context, db *DB) error {
		entry, err := findOutFeed(db, o.Name)
		if err != nil {
			return err
		}
		if !entry.External {
			return fmt.Errorf("syndication output %q is managed (generated from selectors each fetch cycle); a pushed file would be overwritten — recreate it with --external", o.Name)
		}

		src := o.in
		if src == nil {
			src = os.Stdin
		}
		if o.Path != "" && o.Path != "-" {
			f, err := os.Open(o.Path)
			if err != nil {
				return fmt.Errorf("open %s: %w", o.Path, err)
			}
			defer f.Close()
			src = f
		}
		payload, err := io.ReadAll(io.LimitReader(src, maxOutPayload+1))
		if err != nil {
			return fmt.Errorf("read payload: %w", err)
		}
		if int64(len(payload)) > maxOutPayload {
			return fmt.Errorf("payload exceeds %d bytes", maxOutPayload)
		}
		if len(payload) == 0 {
			return fmt.Errorf("empty payload — a generator with nothing to publish should not push")
		}
		if err := validateOutPayload(entry.Format, payload); err != nil {
			return err
		}

		key := outFileKey(*entry)
		if err := db.AtomicPut(ctx, key, bytes.NewReader(payload), store.ObjectMeta{ContentType: outContentType(*entry)}); err != nil {
			return fmt.Errorf("publish %s: %w", key, err)
		}
		if globals.CdnURL != "" {
			slog.Info("published syndication output", "key", key, "bytes", len(payload), "url", joinURL(globals.CdnURL, key))
		} else {
			slog.Info("published syndication output", "key", key, "bytes", len(payload))
		}
		return nil
	})
}

// SyndicateFetchCmd streams the currently published out/<name>.<ext> to
// stdout — the read counterpart of push, enabling stateless read-modify-write
// generators (`srr syndicate fetch x | merge | srr syndicate push x`).
// Read-only, so it works on managed entries too; lock-free like push. The
// payload goes to stdout alone (diagnostics ride stderr), no cap, no
// validation — it returns exactly what is published.
type SyndicateFetchCmd struct {
	Name string `arg:"" help:"Output feed name."`
}

func (o *SyndicateFetchCmd) Run() error {
	return withDB(false, func(ctx context.Context, db *DB) error {
		entry, err := findOutFeed(db, o.Name)
		if err != nil {
			return err
		}
		key := outFileKey(*entry)
		rc, err := db.Get(ctx, key, true)
		if err != nil {
			return fmt.Errorf("read %s: %w", key, err)
		}
		if rc == nil {
			return fmt.Errorf("no published file at %s (nothing pushed or synced yet)", key)
		}
		defer rc.Close()
		if _, err := io.Copy(stdout, rc); err != nil {
			return fmt.Errorf("write payload: %w", err)
		}
		return nil
	})
}

// findOutFeed resolves a syndication entry by name (pointer into core.Out).
// Defense-in-depth like syncOneOutFeed's validOutName re-check: a stored name
// is deserialized straight from db.gz, and push/fetch resolve outFileKey from
// it — a hand-edited "../../db" must not traverse out of out/ on local/SFTP.
func findOutFeed(db *DB, name string) (*OutFeed, error) {
	for i := range db.core.Out {
		if db.core.Out[i].Name == name {
			if !validOutName(name) {
				return nil, fmt.Errorf("syndication output %q has an unsafe name", name)
			}
			return &db.core.Out[i], nil
		}
	}
	return nil, fmt.Errorf("unknown syndication output %q — declare it first: srr syndicate set %s -f rss|json --external", name, name)
}

// validateOutPayload is the push-time well-formedness gate: a broken
// generator must not blank the published feed. rss ⇒ well-formed XML with an
// <rss> root; json ⇒ a JSON object carrying the JSON Feed version marker.
func validateOutPayload(format string, data []byte) error {
	if format == "json" {
		var probe struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			return fmt.Errorf("payload is not valid JSON: %w", err)
		}
		if !strings.HasPrefix(probe.Version, "https://jsonfeed.org/version/") {
			return fmt.Errorf("payload is not a JSON Feed (missing the jsonfeed.org version marker)")
		}
		return nil
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	root := ""
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("payload is not well-formed XML: %w", err)
		}
		if se, ok := tok.(xml.StartElement); ok && root == "" {
			root = se.Name.Local
		}
	}
	if root != "rss" {
		return fmt.Errorf("payload root element is %q, want <rss> (the entry's declared format is rss)", root)
	}
	return nil
}

// setOutFeed validates and upserts one syndication output entry, reaping the
// orphaned old-extension file on a format change. Shared by `srr syndicate set`
// and the PUT handler. The caller supplies a fully-built OutFeed (Limit 0 ⇒
// default applied here).
// validateOutShape checks everything about an OutFeed that does NOT depend on
// the store's feed ids: the name grammar, the format, and the external-slot
// constraints. Split out so `srr import` can validate a document's out[] before
// the feeds it references have been created (ids are store-local) without
// duplicating — and drifting from — these rules.
func validateOutShape(in OutFeed) error {
	if !validOutName(in.Name) {
		return fmt.Errorf("syndication name %q must match [A-Za-z0-9._-] and not be '.' or '..'", in.Name)
	}
	if in.Format != "rss" && in.Format != "json" {
		return fmt.Errorf("format %q is invalid; must be rss or json", in.Format)
	}
	if in.External {
		// A hands-off slot: the fields that would imply generation are hard
		// errors, so a stored entry never lies about how its file is produced.
		if len(in.Tags) > 0 || len(in.Feeds) > 0 {
			return fmt.Errorf("external syndicate takes no selectors (tags/feeds)")
		}
		if in.Limit > 0 {
			return fmt.Errorf("external syndicate takes no limit")
		}
	}
	return nil
}

func setOutFeed(ctx context.Context, db *DB, in OutFeed) error {
	if err := validateOutShape(in); err != nil {
		return err
	}
	if !in.External {
		if len(in.Tags) == 0 && len(in.Feeds) == 0 {
			return fmt.Errorf("at least one of tags or feeds must be non-empty")
		}
		for _, id := range in.Feeds {
			if _, err := db.FeedByID(id); err != nil {
				return fmt.Errorf("feed id %d: unknown", id)
			}
		}
		if in.Limit <= 0 {
			in.Limit = outDefaultLimit
		}
	}

	idx, oldKey := -1, ""
	for i, e := range db.core.Out {
		if e.Name == in.Name {
			idx, oldKey = i, outFileKey(e)
			break
		}
	}
	// Reap the old-extension file BEFORE the Commit that changes the format:
	// once the config no longer names it, nothing can ever delete it (the
	// store has no List), so a crash — or a swallowed Rm failure — after the
	// Commit would strand it forever. This order fails the upsert on a Rm
	// error (config intact, retry works), and a crash between the Rm and the
	// Commit leaves the old config live with its file missing — rewritten by
	// the next fetch process's first cycle (lastOutSig starts empty).
	//
	// Compare resolved KEYS, not raw formats: outFileKey defaults anything that
	// is not "json" to .rss, so a stored entry with an empty format would
	// otherwise read as "changed" against format=rss and delete the very file
	// the new config names.
	// rmIfPresent, not a bare Rm: the old-format file often does not exist
	// (SyncOutFeeds no-ops entirely when SRR_CDN_URL is unset), and a store
	// that errors on deleting a missing key would otherwise make the entry
	// permanently un-editable — the same wedge removeOutFeed guards against.
	if idx >= 0 && oldKey != outFileKey(in) {
		if err := rmIfPresent(ctx, db, oldKey); err != nil {
			return err
		}
	}
	if idx >= 0 {
		db.core.Out[idx] = in
	} else {
		db.core.Out = append(db.core.Out, in)
	}
	return db.Commit(ctx)
}

// removeOutFeed removes a syndication entry's out/* files, then deletes the
// entry by name. Shared by `srr syndicate rm` and the DELETE handler.
func removeOutFeed(ctx context.Context, db *DB, name string) error {
	if !validOutName(name) {
		return fmt.Errorf("syndication name %q must match [A-Za-z0-9._-] and not be '.' or '..'", name)
	}
	// Delete the output files BEFORE the Commit that forgets the entry: once
	// the config no longer names them, nothing can ever delete them (the store
	// has no List), so a crash — or a swallowed Rm failure — after the Commit
	// would strand out/<name>.* forever. This order fails the command on a Rm
	// error (config intact, retry works), and a crash between the Rm and the
	// Commit leaves a still-configured entry whose file the next fetch process
	// rewrites on its first cycle (lastOutSig starts empty).
	//
	// Both extensions are swept (a format change may have left a stray
	// sibling). A Rm failure is tolerated ONLY when the object is provably not
	// there — a store that answers DELETE with 405/403 rather than 404 on a key
	// that never existed would otherwise make the entry permanently
	// undeletable, by `srr syndicate rm` and the API alike. Tolerating by
	// "was it the configured extension?" is not good enough: a real stray
	// whose delete fails would then be dropped from the config and stranded
	// forever, which is precisely what the files-before-Commit order exists to
	// prevent. rmMissingOK asks the store instead of guessing.
	for _, ext := range []string{".rss", ".json"} {
		if err := rmIfPresent(ctx, db, "out/"+name+ext); err != nil {
			return err
		}
	}
	out := db.core.Out[:0]
	for _, e := range db.core.Out {
		if e.Name == name {
			continue
		}
		out = append(out, e)
	}
	db.core.Out = out
	return db.Commit(ctx)
}

// rmIfPresent deletes a syndication output file, tolerating a Rm failure only
// when the store can prove the object is not there. Rm is contractually silent
// on a missing key, but a backend may still error on one — an http:// store
// whose server answers DELETE with 405/403 instead of 404 — and a hard failure
// there would wedge the command forever on a file that never existed. Stat is
// silent on missing, so a 0 size means "nothing to strand" and the error is
// downgraded to a warning; anything else stays fatal, because a file that IS
// present and could not be deleted must keep its config entry (nothing can
// delete it once the config forgets it — the store has no List).
func rmIfPresent(ctx context.Context, db *DB, key string) error {
	rmErr := db.Rm(ctx, key)
	if rmErr == nil {
		return nil
	}
	if n, statErr := db.Stat(ctx, key); statErr == nil && n == 0 {
		slog.Warn("ignoring delete failure for absent syndication output file", "key", key, "error", rmErr)
		return nil
	}
	return fmt.Errorf("remove output file %s: %w", key, rmErr)
}

// outFileKey returns the store key for an OutFeed's output file.
func outFileKey(o OutFeed) string {
	switch o.Format {
	case "json":
		return "out/" + o.Name + ".json"
	default:
		return "out/" + o.Name + ".rss"
	}
}

// outContentType returns the HTTP Content-Type for an OutFeed's output file, so
// S3-hosted syndication feeds (out/*.rss, out/*.json) are recognized by external
// readers rather than served as the application/octet-stream default.
func outContentType(o OutFeed) string {
	if o.Format == "json" {
		return "application/feed+json"
	}
	return "application/rss+xml"
}

// outTitle returns the effective channel title (falls back to Name).
func outTitle(o OutFeed) string {
	if o.Title != "" {
		return o.Title
	}
	return o.Name
}

// joinURL joins a CDN base with a key, handling trailing/missing slashes.
func joinURL(base, key string) string {
	return strings.TrimRight(base, "/") + "/" + key
}
