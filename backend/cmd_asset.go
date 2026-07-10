package main

import (
	"context"
	"fmt"
	"log/slog"
	"mime"
	"os"
	"path"
	"regexp"

	"srr/store"
)

// AssetGroup hosts operator tooling for the self-hosted assets/ store prefix.
type AssetGroup struct {
	Heal AssetHealCmd `cmd:"" help:"Overwrite an existing assets/ object's bytes in place (repair a published-broken asset)."`
}

// assetKeyRe is the strict assets/ key grammar: contentHashKey's
// assets/<2-hex>/<16-hex><ext> shape (extension optional). Anything else —
// packs, db.gz, traversal attempts — is refused outright. Shared by asset-heal
// key validation and expire harvesting (collectAssetRefs), where it is the
// guard keeping adversarial feed content (`assets/../…`) out of Rm's
// path-joining backends.
var assetKeyRe = regexp.MustCompile(`^assets/[0-9a-f]{2}/[0-9a-f]{16}(\.[A-Za-z0-9]+)?$`)

// AssetHealCmd replaces a published asset's bytes under its existing key.
// Articles are immutable and reference the content-hash key forever, so
// repairing a broken published asset (e.g. a truncated video that slipped
// through) means overwriting that key in place — a deliberate, operator-driven
// break of the hash==bytes invariant. Readers that already cached the broken
// bytes (immutable Cache-Control + the service worker's assets bucket) keep
// them; new readers get the repaired object.
type AssetHealCmd struct {
	Key         string `arg:"" help:"Store key to overwrite (assets/<2-hex>/<16-hex><ext>)."`
	File        string `arg:"" type:"existingfile" help:"File whose bytes replace the object."`
	ContentType string `help:"Content-Type to store (default: derived from the key extension)."`
	Create      bool   `help:"Also allow writing a key that does not exist — for re-creating a referenced-but-deleted object. Off by default so a typo'd key can't create an orphan."`
}

func (o *AssetHealCmd) Run() error {
	ctx := context.Background()
	be, err := store.Open(ctx, globals.Store)
	if err != nil {
		return err
	}
	defer be.Close()
	return healAsset(ctx, be, o.Key, o.File, o.ContentType, o.Create)
}

// healAsset validates the key, requires the object to already exist unless
// create is set (a missing key is usually a typo, and creating it would orphan
// an object nothing references — but a referenced-but-deleted key is
// legitimately re-created), and overwrites it with the file's bytes and the
// given or derived Content-Type.
func healAsset(ctx context.Context, be store.Backend, key, file, contentType string, create bool) error {
	if !assetKeyRe.MatchString(key) {
		return fmt.Errorf("key %q is not an assets/<2-hex>/<16-hex><ext> key", key)
	}
	rc, err := be.Get(ctx, key, true)
	if err != nil {
		return fmt.Errorf("check %q: %w", key, err)
	}
	if rc == nil && !create {
		return fmt.Errorf("key %q does not exist — pass --create if an article really references it", key)
	}
	if rc != nil {
		rc.Close()
	}

	if contentType == "" {
		contentType = mime.TypeByExtension(path.Ext(key))
	}
	f, err := os.Open(file)
	if err != nil {
		return fmt.Errorf("open %q: %w", file, err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat %q: %w", file, err)
	}
	if fi.Size() == 0 {
		return fmt.Errorf("%q is empty — refusing to publish a zero-byte asset", file)
	}
	if err := be.AtomicPut(ctx, key, f, store.ObjectMeta{ContentType: contentType}); err != nil {
		return fmt.Errorf("store %q: %w", key, err)
	}
	slog.Info("asset healed", "key", key, "bytes", fi.Size(), "content_type", contentType)
	// The heal overwrites an existing content-hash key in place — the one
	// asset write that reuses a name. A CDN edge fronting the store caches
	// asset keys under a year-long immutable TTL, so the heal stays invisible
	// there (HEAD and GET cached separately) until that exact URL is purged.
	slog.Warn("healed key overwrote published bytes: purge this URL on the CDN edge (cdn.llera.eu) or the old bytes keep serving", "key", key)
	return nil
}
