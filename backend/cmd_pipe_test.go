package main

import (
	"context"
	"slices"
	"testing"
)

func TestResolvePipeNilInheritsRoot(t *testing.T) {
	got := resolvePipe([]string{"#sanitize"}, nil)
	if !slices.Equal(got, []string{"#sanitize"}) {
		t.Errorf("got %v, want [#sanitize]", got)
	}
}

func TestResolvePipeChannelOverridesRoot(t *testing.T) {
	got := resolvePipe([]string{"#sanitize"}, []string{"custom"})
	if !slices.Equal(got, []string{"custom"}) {
		t.Errorf("got %v, want [custom]", got)
	}
}

func TestResolvePipeEmptySliceInheritsRoot(t *testing.T) {
	got := resolvePipe([]string{"#sanitize"}, []string{})
	if !slices.Equal(got, []string{"#sanitize"}) {
		t.Errorf("got %v, want [#sanitize] (empty channel pipe inherits)", got)
	}
}

func TestResolvePipeParentToken(t *testing.T) {
	got := resolvePipe([]string{"#sanitize"}, []string{"#parent", "#minify"})
	if !slices.Equal(got, []string{"#sanitize", "#minify"}) {
		t.Errorf("got %v, want [#sanitize #minify]", got)
	}
}

func TestResolvePipeParentTokenMultiple(t *testing.T) {
	got := resolvePipe([]string{"a", "b"}, []string{"#parent", "x", "#parent"})
	if !slices.Equal(got, []string{"a", "b", "x", "a", "b"}) {
		t.Errorf("got %v, want [a b x a b]", got)
	}
}

func TestFilterPipeDropsEmpties(t *testing.T) {
	if got := filterPipe([]string{""}); got != nil {
		t.Errorf("filterPipe([\"\"]) = %v, want nil", got)
	}
	if got := filterPipe([]string{"a", "", "b"}); !slices.Equal(got, []string{"a", "b"}) {
		t.Errorf("filterPipe got %v, want [a b]", got)
	}
}

func TestNewDBAppliesDefaultRootPipe(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}
	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(context.Background())

	if !slices.Equal(db.core.Pipe, defaultRootPipe()) {
		t.Errorf("fresh DB core.Pipe = %v, want default %v", db.core.Pipe, defaultRootPipe())
	}
}

func TestPipeCmdSetsAndClearsRevertsToDefault(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	if err := (&PipeCmd{Pipe: []string{"custom-only"}}).Run(); err != nil {
		t.Fatalf("set: %v", err)
	}
	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	if !slices.Equal(db.core.Pipe, []string{"custom-only"}) {
		t.Errorf("core.Pipe = %v, want [custom-only]", db.core.Pipe)
	}
	db.Close(context.Background())

	// Pass "" alone → clear. Next NewDB reload re-applies the default
	// because the field is no longer stored.
	if err := (&PipeCmd{Pipe: []string{""}}).Run(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	db, err = NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(context.Background())
	if !slices.Equal(db.core.Pipe, defaultRootPipe()) {
		t.Errorf("core.Pipe after clear = %v, want default %v", db.core.Pipe, defaultRootPipe())
	}
}

func TestPipeCmdPreservesExplicitRootPipe(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	if err := (&PipeCmd{Pipe: []string{"custom-a", "custom-b"}}).Run(); err != nil {
		t.Fatalf("set: %v", err)
	}
	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(context.Background())
	if !slices.Equal(db.core.Pipe, []string{"custom-a", "custom-b"}) {
		t.Errorf("core.Pipe = %v, want [custom-a custom-b]", db.core.Pipe)
	}
}
