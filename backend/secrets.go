package main

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// secrets holds the srr.yaml `secrets:` section — scope → env-var name → value.
// A scope is a named bundle of credentials (e.g. `telegram`, `github`) that
// recipes and feeds GRANT to their external ingest/mod commands via the
// `secrets` axis; only granted scopes reach a command's environment
// (mod.SubprocessEnv), so the blast radius of one misbehaving script is the
// scopes it was granted, never the whole credential set. Parsed once at startup
// and pushed into the mod package via mod.SetSecrets; nil when the section is
// absent. Read by `srr config` (masked).
var secrets map[string]map[string]string

// parseSecrets extracts the optional top-level `secrets:` section from the raw
// srr.yaml bytes — scope name → (env-var name → value). Other top-level keys
// (globals, backend sections) are ignored. An empty scope name, or one
// containing '.', is rejected ('.' would break the `srr config
// secrets.<scope>.<NAME>` lookup); an empty var name, or one containing '=',
// is rejected (either would corrupt the KEY=VALUE environment wire). A
// pre-scope flat map (name → value directly under `secrets:`) fails with a
// migration hint rather than a bare yaml type error. An absent section yields
// a nil map and no error.
func parseSecrets(configData []byte) (map[string]map[string]string, error) {
	if len(configData) == 0 {
		return nil, nil
	}
	var doc struct {
		Secrets map[string]map[string]string `yaml:"secrets"`
	}
	if err := yaml.Unmarshal(configData, &doc); err != nil {
		var flat struct {
			Secrets map[string]string `yaml:"secrets"`
		}
		if yaml.Unmarshal(configData, &flat) == nil && len(flat.Secrets) > 0 {
			return nil, fmt.Errorf("secrets are scoped now (secrets → scope → name → value): wrap the entries under a scope name and grant it via `srr recipe set --secrets <scope>` or `srr feed upd --secrets <scope>`")
		}
		return nil, fmt.Errorf("parsing secrets: %w", err)
	}
	for scope, vars := range doc.Secrets {
		if scope == "" {
			return nil, fmt.Errorf("invalid secret scope name: must not be empty")
		}
		if strings.Contains(scope, ".") {
			return nil, fmt.Errorf("invalid secret scope name %q: must not contain '.'", scope)
		}
		for name := range vars {
			if name == "" {
				return nil, fmt.Errorf("secret scope %q: invalid secret name: must not be empty", scope)
			}
			if strings.Contains(name, "=") {
				return nil, fmt.Errorf("secret scope %q: invalid secret name %q: must not contain '='", scope, name)
			}
		}
	}
	return doc.Secrets, nil
}
