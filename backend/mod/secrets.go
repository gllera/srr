package mod

import (
	"context"
	"maps"
	"os"
	"slices"
	"strings"
)

// secrets holds the operator-declared secret scopes from srr.yaml's `secrets:`
// section — scope name → (env-var name → value). A command's environment only
// ever receives the scopes its feed/recipe GRANTED (the `secrets` axis,
// resolved by main and stamped onto the fetch ctx via WithSecretScopes), so the
// blast radius of one external script is its grant, never the whole credential
// set. Set once at startup by main via SetSecrets, before any subprocess runs.
// nil/empty means "no secrets".
var secrets map[string]map[string]string

// SetSecrets registers the srr.yaml `secrets:` scopes for SubprocessEnv.
// Passing nil clears them (used by tests and the no-section case).
func SetSecrets(s map[string]map[string]string) { secrets = s }

// AllScopes returns every configured scope name, sorted — the grant for
// operator-global commands (the notify hook), which are trusted like the
// srr.yaml that declares both them and the secrets.
func AllScopes() []string {
	if len(secrets) == 0 {
		return nil
	}
	return slices.Sorted(maps.Keys(secrets))
}

// MissingScopes returns, in grant order, the scopes that srr.yaml does not
// define — the fetch call site warns on them once per feed, since a recipe in
// the (shared) store may legitimately name scopes another box's srr.yaml
// lacks. An unknown scope simply contributes no vars.
func MissingScopes(scopes []string) []string {
	var missing []string
	for _, s := range scopes {
		if _, ok := secrets[s]; !ok {
			missing = append(missing, s)
		}
	}
	return missing
}

type secretScopesKey struct{}

// WithSecretScopes returns ctx with the resolved secret-scope grant attached.
// main.Feed.Fetch (and preview) stamp it after resolving the feed > recipe >
// default axis; SubprocessEnv reads it back. An unstamped ctx means NO grant —
// fail-closed: a path that forgets to resolve leaks nothing.
func WithSecretScopes(ctx context.Context, scopes []string) context.Context {
	if len(scopes) == 0 {
		return ctx
	}
	return context.WithValue(ctx, secretScopesKey{}, scopes)
}

// secretScopesFromContext returns the grant stamped by WithSecretScopes, or nil.
func secretScopesFromContext(ctx context.Context) []string {
	scopes, _ := ctx.Value(secretScopesKey{}).([]string)
	return scopes
}

// SubprocessEnv returns the environment handed to an external ingest/mod
// command: the process environment (os.Environ) with the ctx-granted scopes'
// secrets overlaid so a secret REPLACES — not merely shadows — any ambient var
// of the same name (secrets win; when two granted scopes define the same var,
// the later grant wins). The result is deduped to one entry per name and
// sorted for determinism. (A plain append won't do: exec.Cmd does not dedup
// env, and whether a later duplicate wins is up to the child runtime —
// shell/Python keep the last, but glibc/Go getenv return the first, so an
// ambient var could beat a secret.) With no granted secrets it returns
// os.Environ() unchanged. Shared by Module.Process and ingest's external path
// so both subprocess paths see the same merged environment.
func SubprocessEnv(ctx context.Context) []string {
	base := os.Environ()
	granted := secretScopesFromContext(ctx)

	total := 0
	for _, scope := range granted {
		total += len(secrets[scope])
	}
	if total == 0 {
		return base
	}

	merged := make(map[string]string, len(base)+total)
	for _, kv := range base {
		if k, v, ok := strings.Cut(kv, "="); ok {
			merged[k] = v
		}
	}
	for _, scope := range granted {
		maps.Copy(merged, secrets[scope])
	}

	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	slices.Sort(out)
	return out
}
