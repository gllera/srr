package mod

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type RawItem struct {
	GUID      uint32     `json:"guid"`
	Title     string     `json:"title"`
	Content   string     `json:"content"`
	Link      string     `json:"link"`
	Published *time.Time `json:"published"`
	Raw       any        `json:"raw"`
}

var registry = map[string]func() func(*RawItem) error{}

// Register registers a built-in processor available as "#name".
func Register(name string, init func() func(*RawItem) error) {
	if !strings.HasPrefix(name, "#") {
		name = "#" + name
	}
	registry[name] = init
}

type Module struct {
	processors map[string]func(*RawItem) error
	env        []string
}

func New() *Module {
	m := &Module{
		processors: make(map[string]func(*RawItem) error, len(registry)),
		env:        os.Environ(),
	}
	for name, init := range registry {
		m.processors[name] = init()
	}
	return m
}

func (o *Module) Process(ctx context.Context, args string, i *RawItem) error {
	if fn, ok := o.processors[args]; ok {
		return fn(i)
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(i); err != nil {
		return err
	}

	var out bytes.Buffer
	GUID := i.GUID

	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", args)
	cmd.Stdin = &buf
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	cmd.Env = o.env

	if err := cmd.Run(); err != nil {
		return err
	}

	if err := json.Unmarshal(out.Bytes(), i); err != nil {
		return err
	}

	if GUID != i.GUID {
		return fmt.Errorf("field GUID cannot be updated")
	}

	return nil
}
