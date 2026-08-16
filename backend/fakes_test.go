package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"srr/store"
)

// The shared store fakes. Seven near-identical types used to live one per test
// file, each embedding store.Backend and differing only in WHICH operation it
// broke and for WHICH keys — a predicate, not a type. Fakes with genuinely
// distinct behaviour (counting, gating, failing mid-write) stay where they are
// used.

// noListBackend is a store that cannot enumerate itself — plain HTTP's shape.
type noListBackend struct{ store.Backend }

func (noListBackend) List(context.Context, string) ([]string, error) {
	return nil, errors.ErrUnsupported
}

// faultBackend injects a failure into one operation and promotes everything
// else from the embedded store. A nil hook leaves that operation untouched.
type faultBackend struct {
	store.Backend
	put  func(key string) error
	rm   func(key string) error
	stat func(key string) error
}

func (f *faultBackend) AtomicPut(ctx context.Context, key string, r io.Reader, m store.ObjectMeta) error {
	if f.put != nil {
		if err := f.put(key); err != nil {
			return err
		}
	}
	return f.Backend.AtomicPut(ctx, key, r, m)
}

func (f *faultBackend) Rm(ctx context.Context, key string) error {
	if f.rm != nil {
		if err := f.rm(key); err != nil {
			return err
		}
	}
	return f.Backend.Rm(ctx, key)
}

func (f *faultBackend) Stat(ctx context.Context, key string) (int64, error) {
	if f.stat != nil {
		if err := f.stat(key); err != nil {
			return 0, err
		}
	}
	return f.Backend.Stat(ctx, key)
}

// failKey fails for exactly one key, failPrefix for every key under a prefix,
// failAll for every key. Each returns a hook for one of faultBackend's fields.
func failKey(key string) func(string) error {
	return func(k string) error {
		if k == key {
			return fmt.Errorf("injected failure for %q", k)
		}
		return nil
	}
}

func failPrefix(prefix string) func(string) error {
	return func(k string) error {
		if strings.HasPrefix(k, prefix) {
			return fmt.Errorf("injected failure for %q", k)
		}
		return nil
	}
}

func failAll() func(string) error {
	return func(k string) error { return fmt.Errorf("injected failure for %q", k) }
}
