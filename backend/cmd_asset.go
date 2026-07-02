package main

import (
	"context"
	"fmt"
	"log/slog"
	"mime"
	"os"
	"path"
	"regexp"

	"srrb/store"
)

// AssetGroup hosts operator tooling for the self-hosted assets/ store prefix.
type AssetGroup struct {
	Heal AssetHealCmd `cmd:"" help:"Overwrite an existing assets/ object's bytes in place (repair a published-broken asset)."`
}

// healKeyRe is the assets/ key grammar heal accepts: contentHashKey's
// assets/<2-hex>/<16-hex><ext> shape (extension optional). Anything else —
// packs, db.gz, traversal attempts — is refused outright.
var healKeyRe = regexp.MustCompile(`^assets/[0-9a-f]{2}/[0-9a-f]{16}(\.[A-Za-z0-9]+)?$`)

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
}

func (o *AssetHealCmd) Run() error {
	ctx := context.Background()
	be, err := store.Open(ctx, globals.Store)
	if err != nil {
		return err
	}
	defer be.Close()
	return healAsset(ctx, be, o.Key, o.File, o.ContentType)
}

// healAsset validates the key, requires the object to already exist (a missing
// key is a typo, and creating it would orphan an object nothing references),
// and overwrites it with the file's bytes and the given or derived Content-Type.
func healAsset(ctx context.Context, be store.Backend, key, file, contentType string) error {
	if !healKeyRe.MatchString(key) {
		return fmt.Errorf("key %q is not an assets/<2-hex>/<16-hex><ext> key", key)
	}
	rc, err := be.Get(ctx, key, true)
	if err != nil {
		return fmt.Errorf("check %q: %w", key, err)
	}
	if rc == nil {
		return fmt.Errorf("key %q does not exist — heal replaces a published asset, it never creates one", key)
	}
	rc.Close()

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
	return nil
}
