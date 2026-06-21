package main

import (
	"reflect"
	"testing"
)

func TestGlobalEnvName(t *testing.T) {
	type g struct {
		Workers int    `env:"SRR_WORKERS"`
		NoEnv   string ``
	}
	tt := reflect.TypeOf(g{})
	if got := globalEnvName(tt.Field(0)); got != "SRR_WORKERS" {
		t.Errorf("globalEnvName(Workers) = %q, want SRR_WORKERS", got)
	}
	if got := globalEnvName(tt.Field(1)); got != "" {
		t.Errorf("globalEnvName(NoEnv) = %q, want empty", got)
	}
}

func TestBackendEnvNameFor(t *testing.T) {
	type cfg struct {
		Region    string `yaml:"region"`
		AccessKey string `yaml:"access-key-id"`
		NoTag     string ``
	}
	tt := reflect.TypeOf(cfg{})
	envName := backendEnvNameFor("s3")
	cases := []struct {
		field int
		want  string
	}{
		{0, "SRR_S3_REGION"},
		{1, "SRR_S3_ACCESS_KEY_ID"},
		{2, ""}, // no yaml tag → no derived env name
	}
	for _, c := range cases {
		if got := envName(tt.Field(c.field)); got != c.want {
			t.Errorf("backendEnvNameFor(s3)(%s) = %q, want %q", tt.Field(c.field).Name, got, c.want)
		}
	}
}
