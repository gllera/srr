package main

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// secrets holds the srr.yaml `secrets:` section — a flat map of environment
// variable name → value, merged into external ingest/mod command environments by
// mod.SubprocessEnv (secrets win over the ambient process env). Parsed once at
// startup and pushed into the mod package via mod.SetSecrets; nil when the
// section is absent. Read by `srr config` (masked).
var secrets map[string]string

// parseSecrets extracts the optional top-level `secrets:` section from the raw
// srr.yaml bytes — a flat map of env-var name → value. Other top-level keys
// (globals, backend sections) are ignored. An empty name, or a name containing
// '=', is rejected (either would corrupt the KEY=VALUE environment wire). An
// absent section yields a nil map and no error.
func parseSecrets(configData []byte) (map[string]string, error) {
	if len(configData) == 0 {
		return nil, nil
	}
	var doc struct {
		Secrets map[string]string `yaml:"secrets"`
	}
	if err := yaml.Unmarshal(configData, &doc); err != nil {
		return nil, fmt.Errorf("parsing secrets: %w", err)
	}
	for name := range doc.Secrets {
		if name == "" {
			return nil, fmt.Errorf("invalid secret name: must not be empty")
		}
		if strings.Contains(name, "=") {
			return nil, fmt.Errorf("invalid secret name %q: must not contain '='", name)
		}
	}
	return doc.Secrets, nil
}
