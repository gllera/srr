package main

import (
	"reflect"
	"strings"
	"testing"
)

// jsonTags collects a struct's json field names (first tag segment; "-" and
// untagged fields skipped).
func jsonTags(t reflect.Type) map[string]bool {
	out := map[string]bool{}
	for i := range t.NumField() {
		tag, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if tag != "" && tag != "-" {
			out[tag] = true
		}
	}
	return out
}

// TestWritableFeedFieldsRouteEverywhere pins the ONE writable-feed projection
// against its hand-written copies, the way TestFeedSplitCoversEveryWireField
// pins the manifest/config split. feedView (feed ls/show/apply/edit) is the
// canonical shape; configFeed (srr config export/import), addFeedIn /
// updateFeedIn (the MCP tools) and feedListView (the admin GUI, whose save is
// full-replace) must each carry every writable field — a knob missing from any
// of them is silently WIPED by a save through that surface, the bug class the
// TestServeFeedSave…RoundTrips* pins each caught once, one field at a time.
func TestWritableFeedFieldsRouteEverywhere(t *testing.T) {
	writable := jsonTags(reflect.TypeOf(feedView{}))
	// The server-owned read-only fields (reported, never applied back) and the
	// identity field. A new read-only field must be added here — everything
	// else in feedView is writable by definition.
	for _, ro := range []string{"id", "error", "expired", "content_bytes", "asset_bytes"} {
		if !writable[ro] {
			t.Fatalf("feedView lost its %q field; update this test's read-only list if that was deliberate", ro)
		}
		delete(writable, ro)
	}

	exact := func(name string, tags map[string]bool, extras ...string) {
		t.Helper()
		for _, e := range extras {
			delete(tags, e)
		}
		for f := range writable {
			if !tags[f] {
				t.Errorf("%s is missing writable feed field %q — a save through that surface silently wipes it", name, f)
			}
		}
		for f := range tags {
			if !writable[f] {
				t.Errorf("%s carries field %q that feedView does not know — it cannot round-trip through feed apply/edit", name, f)
			}
		}
	}
	exact("configFeed", jsonTags(reflect.TypeOf(configFeed{})))
	exact("addFeedIn", jsonTags(reflect.TypeOf(addFeedIn{})))
	exact("updateFeedIn", jsonTags(reflect.TypeOf(updateFeedIn{})), "id")

	// feedListView additionally carries the read-only health/stat projection,
	// so it is a superset: it must CONTAIN every writable field (the GUI's
	// full-replace save round-trips them all through it).
	lv := jsonTags(reflect.TypeOf(feedListView{}))
	for f := range writable {
		if !lv[f] {
			t.Errorf("feedListView is missing writable feed field %q — the GUI's full-replace save silently wipes it", f)
		}
	}
}

// TestFeedViewCopiesRoundTrip nets the ASSIGNMENTS, which the test above does
// not: a field can be present in every struct and still be dropped by one of
// the hand-written copy functions between them, and the result is a silent
// zero-write rather than a compile error. Both round trips must be identity
// over the writable set:
//
//	feedView -> Feed -> feedView          (writeFeedView / viewOf)
//	feedView -> configFeed -> feedView    (configFeedOf / configFeed.view)
//
// The source view is filled by REFLECTION, so a newly added writable field is
// exercised without anyone remembering to extend a literal here.
func TestFeedViewCopiesRoundTrip(t *testing.T) {
	readOnly := map[string]bool{"id": true, "error": true, "expired": true, "content_bytes": true, "asset_bytes": true}
	src := &feedView{}
	rv := reflect.ValueOf(src).Elem()
	rt := rv.Type()
	for i := range rt.NumField() {
		tag, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
		if tag == "" || tag == "-" || readOnly[tag] {
			continue
		}
		f := rv.Field(i)
		switch f.Kind() {
		case reflect.String:
			f.SetString("v-" + tag)
		case reflect.Bool:
			f.SetBool(true)
		case reflect.Int, reflect.Int64:
			f.SetInt(7)
		case reflect.Slice:
			f.Set(reflect.ValueOf([]string{"s-" + tag}))
		default:
			t.Fatalf("feedView.%s has kind %s this test cannot fill — extend it", rt.Field(i).Name, f.Kind())
		}
	}

	// Only the writable fields survive a round trip by design (viewOf fills the
	// read-only ones from the stored feed), so compare on those.
	writableOnly := func(v *feedView) feedView {
		out := *v
		out.ID, out.Error, out.Expired, out.ContentBytes, out.AssetBytes = nil, "", 0, 0, 0
		return out
	}
	want := writableOnly(src)

	ch := &Feed{}
	writeFeedView(ch, src)
	if got := writableOnly(viewOf(ch)); !reflect.DeepEqual(got, want) {
		t.Errorf("feedView -> Feed -> feedView lost a field:\n got %+v\nwant %+v", got, want)
	}

	cf := configFeedOf(src)
	if got := writableOnly(cf.view()); !reflect.DeepEqual(got, want) {
		t.Errorf("feedView -> configFeed -> feedView lost a field:\n got %+v\nwant %+v", got, want)
	}
}
