package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The MCP surface has three contracts, and this file pins one per layer:
//
//  1. HANDLER — the tool semantics themselves (mcp_tools.go), called directly
//     with no transport in the way.
//  2. HTTP — the streamable endpoint mounted by newMux(), exercised through
//     hostGuard exactly as a remote client reaches it.
//  3. STDIO-EQUIVALENT — newMCPServer().Run over an in-memory transport pair,
//     which is the `srr mcp` code path minus the OS pipes (no subprocess).

// --- layer 1: handlers ------------------------------------------------------

// mcpTestStore commits three fetch cycles of two articles each against two
// tagged feeds, so chron 0..5 carries three distinct fetched_at stamps (the
// window clock) and one accented title (the folded-query probe). Cycle stamps
// are shared with the `srr art ls` window tests (artCycleTimes).
func mcpTestStore(t *testing.T) (*DB, *Feed, *Feed) {
	t.Helper()
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
	f0 := &Feed{Title: "News feed", URL: "https://n.example/f", Tag: "news"}
	f1 := &Feed{Title: "Tech feed", URL: "https://t.example/f", Tag: "tech"}
	if err := db.AddFeed(f0); err != nil {
		t.Fatalf("AddFeed f0: %v", err)
	}
	if err := db.AddFeed(f1); err != nil {
		t.Fatalf("AddFeed f1: %v", err)
	}
	titles := [][2]string{
		{"Café central", "beta"}, // chron 0,1
		{"gamma", "delta"},       // chron 2,3
		{"epsilon", "zeta"},      // chron 4,5
	}
	for i, pair := range titles {
		db.core.FetchedAt = artCycleTimes[i].Unix()
		if _, err := db.PutArticles(ctx, []*Item{
			{Feed: f0, Title: pair[0], Content: "body", Link: "l"},
			{Feed: f1, Title: pair[1], Content: "body", Link: "l"},
		}); err != nil {
			t.Fatalf("PutArticles cycle %d: %v", i, err)
		}
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	return db, f0, f1
}

func mcpTitles(out listArticlesOut) []string {
	titles := make([]string, len(out.Articles))
	for i, a := range out.Articles {
		titles[i] = a.Title
	}
	return titles
}

// srr_overview hands back the admin console's own projection verbatim: the
// per-feed fetch-health vitals the GUI table renders, and the running binary's
// version (which is how a client tells which srr it is talking to).
func TestMCPOverviewCarriesVitalsAndVersion(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
	seedFeed(t, db, &Feed{
		Title:      "Broken feed",
		URL:        "https://b.example/f",
		Tag:        "news",
		FetchError: "502 bad gateway",
		FailStreak: 3,
		LastOK:     1700000000,
		LastNew:    1690000000,
		TotalArt:   7,
	})

	_, out, err := mcpOverview(ctx, nil, struct{}{})
	if err != nil {
		t.Fatalf("mcpOverview: %v", err)
	}
	if out.Store.Version != version {
		t.Errorf("version = %q, want %q (the running binary's)", out.Store.Version, version)
	}
	if len(out.Store.Feeds) != 1 {
		t.Fatalf("feeds = %d, want 1", len(out.Store.Feeds))
	}
	f := out.Store.Feeds[0]
	if f.Error != "502 bad gateway" || f.FailStreak != 3 || f.LastOK != 1700000000 || f.LastNew != 1690000000 || f.TotalArt != 7 {
		t.Errorf("feed vitals not projected: %+v", f)
	}
	if len(out.Store.Tags) != 1 || out.Store.Tags[0].Tag != "news" {
		t.Errorf("tags = %+v, want one 'news' bucket", out.Store.Tags)
	}
	if _, ok := out.Store.Recipes[defaultRecipeName]; !ok {
		t.Errorf("recipes missing the reserved %q entry: %+v", defaultRecipeName, out.Store.Recipes)
	}
}

// srr_list_articles is listArticles behind a tool schema: the same folded
// title query, half-open fetched_at window, cursor pagination and feed-title
// resolution — plus its own include_content switch, off by default because
// content dominates the payload.
func TestMCPListArticles(t *testing.T) {
	mcpTestStore(t)

	t.Run("newest first with feed titles, content withheld", func(t *testing.T) {
		_, out, err := mcpListArticles(ctx, nil, listArticlesIn{})
		if err != nil {
			t.Fatalf("mcpListArticles: %v", err)
		}
		if out.Total != 6 {
			t.Errorf("Total = %d, want 6", out.Total)
		}
		want := []string{"zeta", "epsilon", "delta", "gamma", "beta", "Café central"}
		if got := mcpTitles(out); !slices.Equal(got, want) {
			t.Errorf("titles = %v, want %v", got, want)
		}
		if out.Articles[0].FeedTitle != "Tech feed" {
			t.Errorf("FeedTitle = %q, want %q (resolved in the same read)", out.Articles[0].FeedTitle, "Tech feed")
		}
		for _, a := range out.Articles {
			if a.Content != "" {
				t.Fatalf("article %q carries content with include_content off", a.Title)
			}
		}
	})

	t.Run("include_content on", func(t *testing.T) {
		_, out, err := mcpListArticles(ctx, nil, listArticlesIn{IncludeContent: true})
		if err != nil {
			t.Fatalf("mcpListArticles: %v", err)
		}
		for _, a := range out.Articles {
			if a.Content != "body" {
				t.Errorf("article %q content = %q, want the stored body", a.Title, a.Content)
			}
		}
	})

	t.Run("folded query", func(t *testing.T) {
		// "cafe" matches "Café central": the query rides foldSearchText, the
		// same accent/case folding the frontend's search uses.
		_, out, err := mcpListArticles(ctx, nil, listArticlesIn{Query: "cafe"})
		if err != nil {
			t.Fatalf("mcpListArticles: %v", err)
		}
		if want := []string{"Café central"}; !slices.Equal(mcpTitles(out), want) {
			t.Fatalf("titles = %v, want %v", mcpTitles(out), want)
		}
		if out.Total != 1 {
			t.Errorf("Total = %d, want 1 (matches inside the window, not the store total)", out.Total)
		}
	})

	t.Run("window is half-open on fetched_at", func(t *testing.T) {
		// since = cycle 1's stamp (inclusive), until = cycle 2's (exclusive):
		// exactly the middle cycle's two articles.
		_, out, err := mcpListArticles(ctx, nil, listArticlesIn{Since: artStamp(1), Until: artStamp(2)})
		if err != nil {
			t.Fatalf("mcpListArticles: %v", err)
		}
		if want := []string{"delta", "gamma"}; !slices.Equal(mcpTitles(out), want) {
			t.Errorf("titles = %v, want %v", mcpTitles(out), want)
		}
		if out.Total != 2 {
			t.Errorf("Total = %d, want 2", out.Total)
		}
	})

	t.Run("cursor pagination", func(t *testing.T) {
		_, p1, err := mcpListArticles(ctx, nil, listArticlesIn{Limit: 2})
		if err != nil {
			t.Fatalf("page 1: %v", err)
		}
		if want := []string{"zeta", "epsilon"}; !slices.Equal(mcpTitles(p1), want) {
			t.Fatalf("page 1 titles = %v, want %v", mcpTitles(p1), want)
		}
		if p1.NextCursor == nil {
			t.Fatal("page 1 NextCursor = nil, want the lowest chron returned")
		}
		if *p1.NextCursor != p1.Articles[1].ChronIdx {
			t.Errorf("NextCursor = %d, want %d (the page's lowest chron_idx)", *p1.NextCursor, p1.Articles[1].ChronIdx)
		}
		_, p2, err := mcpListArticles(ctx, nil, listArticlesIn{Limit: 2, Before: p1.NextCursor})
		if err != nil {
			t.Fatalf("page 2: %v", err)
		}
		if want := []string{"delta", "gamma"}; !slices.Equal(mcpTitles(p2), want) {
			t.Errorf("page 2 titles = %v, want %v (before cursor is exclusive)", mcpTitles(p2), want)
		}
	})

	t.Run("feed filter", func(t *testing.T) {
		_, out, err := mcpListArticles(ctx, nil, listArticlesIn{Tags: []string{"news"}})
		if err != nil {
			t.Fatalf("mcpListArticles: %v", err)
		}
		if want := []string{"epsilon", "gamma", "Café central"}; !slices.Equal(mcpTitles(out), want) {
			t.Errorf("titles = %v, want %v (tag news = feed 0)", mcpTitles(out), want)
		}
	})

	t.Run("limit is capped, never unbounded", func(t *testing.T) {
		// The cap is what keeps a tool result a context-window payload; the
		// store is smaller than either bound, so this pins that a huge ask is
		// accepted rather than rejected, and simply clamped.
		_, out, err := mcpListArticles(ctx, nil, listArticlesIn{Limit: 10 * mcpMaxArticleLimit})
		if err != nil {
			t.Fatalf("mcpListArticles: %v", err)
		}
		if len(out.Articles) != 6 {
			t.Errorf("articles = %d, want 6", len(out.Articles))
		}
	})
}

// A bad since/until value fails with parseTimeBound's grammar message, prefixed
// by the FIELD name (not the CLI flag name) — parseMCPWindow's own wording,
// which is why ArtCmd.window's test-pinned "--since" messages stay untouched.
func TestMCPListArticlesBadTimeBound(t *testing.T) {
	mcpTestStore(t)

	_, _, err := mcpListArticles(ctx, nil, listArticlesIn{Since: "garbage"})
	wantErr(t, err, `since: invalid time "garbage"`)
	wantErr(t, err, "want a duration before now")
	if strings.Contains(err.Error(), "--since") {
		t.Errorf("error names the CLI flag, want the tool field: %v", err)
	}

	_, _, err = mcpListArticles(ctx, nil, listArticlesIn{Until: "nope"})
	wantErr(t, err, `until: invalid time "nope"`)

	_, _, err = mcpListArticles(ctx, nil, listArticlesIn{Since: artStamp(2), Until: artStamp(1)})
	wantErr(t, err, "the window is empty")
}

// THE merge-on-absent contract: srr_update_feed applies only the fields the
// call actually supplied. A call that sets nothing but `tag` must leave
// title/url/pipe/expire_days exactly as stored — the deliberate deviation from
// the GUI's full-replace save, where an omitted field means "clear it".
func TestMCPUpdateFeedMergesOnAbsent(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()

	_, added, err := mcpAddFeed(ctx, nil, addFeedIn{
		Title:      "News",
		URL:        "https://n.example/feed",
		Tag:        "news",
		Ingest:     "#feed",
		Pipe:       []string{"#unlazy", "#default"},
		ExpireDays: 30,
		DedupTitle: true,
	})
	if err != nil {
		t.Fatalf("mcpAddFeed: %v", err)
	}
	id := added.Feed.ID

	// Only `tag` is present: everything else keeps its stored value.
	_, upd, err := mcpUpdateFeed(ctx, nil, updateFeedIn{ID: id, Tag: strPtr("news/tech")})
	if err != nil {
		t.Fatalf("mcpUpdateFeed: %v", err)
	}
	got := upd.Feed
	if got.Tag != "news/tech" {
		t.Errorf("Tag = %q, want the supplied value", got.Tag)
	}
	if got.Title != "News" || got.URL != "https://n.example/feed" {
		t.Errorf("title/url not preserved: %q %q", got.Title, got.URL)
	}
	if want := []string{"#unlazy", "#default"}; !slices.Equal(got.Pipe, want) {
		t.Errorf("Pipe = %v, want %v (absent means keep)", got.Pipe, want)
	}
	if got.Ingest != "#feed" {
		t.Errorf("Ingest = %q, want #feed (absent means keep)", got.Ingest)
	}
	if got.ExpireDays != 30 || !got.DedupTitle {
		t.Errorf("expire_days/dedup_title not preserved: %d %v", got.ExpireDays, got.DedupTitle)
	}

	// An EXPLICIT empty value still clears — that difference between "not
	// mentioned" and "set to empty" is exactly what the pointers buy.
	_, cleared, err := mcpUpdateFeed(ctx, nil, updateFeedIn{ID: id, Ingest: strPtr("")})
	if err != nil {
		t.Fatalf("mcpUpdateFeed clear: %v", err)
	}
	if cleared.Feed.Ingest != "" {
		t.Errorf("Ingest = %q, want cleared by the explicit empty value", cleared.Feed.Ingest)
	}
	if want := []string{"#unlazy", "#default"}; !slices.Equal(cleared.Feed.Pipe, want) {
		t.Errorf("Pipe = %v, want %v (the other axis is untouched)", cleared.Feed.Pipe, want)
	}
	if cleared.Feed.Tag != "news/tech" {
		t.Errorf("Tag = %q, want the previously merged value", cleared.Feed.Tag)
	}

	// The write really landed in the store, not just in the echoed view.
	db := reopenDB(t)
	ch, err := db.FeedByID(id)
	if err != nil {
		t.Fatalf("FeedByID: %v", err)
	}
	if ch.Tag != "news/tech" || ch.Title != "News" || ch.Ingest != "" || len(ch.Pipe) != 2 {
		t.Errorf("stored feed = %+v, want the merged state", ch)
	}
}

// An unknown feed id is reported with the id in the message, on both the read
// (update) and the write-cycle (fetch) path — the caller composed that number,
// so it has to see which one was wrong.
func TestMCPUnknownFeedID(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()

	_, _, err := mcpUpdateFeed(ctx, nil, updateFeedIn{ID: 4242, Title: strPtr("x")})
	wantErr(t, err, "feed id 4242 not found")

	// srr_fetch resolves ids before any outbound request, so an unknown id
	// fails the whole cycle offline.
	_, _, err = mcpFetch(ctx, nil, fetchIn{FeedIDs: []int{4242}})
	wantErr(t, err, "feed id 4242 not found")
}

// A store lock held by another srr process — in production almost always the
// fetch loop mid-cycle — surfaces as the operator-grade "store busy" message,
// not as a raw os.ErrExist / "create lock file" leak. This is the tool-layer
// mirror of the admin API's 409 contract.
func TestMCPFetchStoreBusy(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()

	// A second, LOCKED handle: NewDB creates `.locked` directly (it does not
	// go through the in-process storeWriter gate), so the tool call below hits
	// the same cross-process contention a real fetch loop produces.
	holder, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB(locked): %v", err)
	}
	defer holder.Close(ctx)

	_, _, err = mcpFetch(ctx, nil, fetchIn{})
	wantErr(t, err, msgMCPStoreBusy)

	// A feed write takes the same lock and reports the same thing.
	_, _, err = mcpAddFeed(ctx, nil, addFeedIn{Title: "News", URL: "https://n.example/feed"})
	wantErr(t, err, msgMCPStoreBusy)
}

// --- layer 2: HTTP transport ------------------------------------------------

// mcpReq POSTs one JSON-RPC message to /mcp with the headers the streamable
// HTTP transport requires (the SDK 415s a wrong Content-Type and 400s an
// Accept that doesn't name both media types).
func mcpReq(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = "localhost"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// mcpRPC sends one message and decodes the JSON-RPC envelope. JSONResponse is
// on, so the reply is a plain JSON body — no SSE framing to strip.
func mcpRPC(t *testing.T, h http.Handler, body string) map[string]any {
	t.Helper()
	rec := mcpReq(t, h, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /mcp = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json (JSONResponse)", ct)
	}
	var env map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode reply: %v (raw: %s)", err, rec.Body)
	}
	if e, ok := env["error"]; ok {
		t.Fatalf("JSON-RPC error: %v", e)
	}
	res, ok := env["result"].(map[string]any)
	if !ok {
		t.Fatalf("reply has no result object: %s", rec.Body)
	}
	return res
}

// The full remote client handshake over the mounted endpoint: initialize,
// tools/list (every registered tool), then a real tools/call answering from
// the store. Stateless mode means each POST stands alone — no session header.
func TestMCPHTTPEndpoint(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
	seedFeed(t, db, &Feed{Title: "News feed", URL: "https://n.example/f", Tag: "news"})
	h := newMux()

	t.Run("initialize", func(t *testing.T) {
		res := mcpRPC(t, h, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":`+
			`{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}`)
		info, _ := res["serverInfo"].(map[string]any)
		if info["name"] != "srr" {
			t.Errorf("serverInfo.name = %v, want srr", info["name"])
		}
		if info["version"] != version {
			t.Errorf("serverInfo.version = %v, want %q", info["version"], version)
		}
	})

	t.Run("tools/list", func(t *testing.T) {
		res := mcpRPC(t, h, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
		list, _ := res["tools"].([]any)
		var names []string
		for _, tl := range list {
			m, _ := tl.(map[string]any)
			name, _ := m["name"].(string)
			names = append(names, name)
		}
		slices.Sort(names)
		want := []string{
			"srr_add_feed", "srr_fetch", "srr_list_articles", "srr_overview",
			"srr_preview_feed", "srr_resolve_feed", "srr_update_feed",
		}
		if !slices.Equal(names, want) {
			t.Errorf("tools = %v, want %v", names, want)
		}
	})

	t.Run("tools/call srr_overview", func(t *testing.T) {
		res := mcpRPC(t, h, `{"jsonrpc":"2.0","id":3,"method":"tools/call",`+
			`"params":{"name":"srr_overview","arguments":{}}}`)
		if res["isError"] == true {
			t.Fatalf("tool reported an error: %v", res)
		}
		sc, ok := res["structuredContent"].(map[string]any)
		if !ok {
			t.Fatalf("no structuredContent: %v", res)
		}
		store, _ := sc["store"].(map[string]any)
		if store["version"] != version {
			t.Errorf("store.version = %v, want %q", store["version"], version)
		}
		feeds, _ := store["feeds"].([]any)
		if len(feeds) != 1 {
			t.Fatalf("feeds = %v, want the one seeded feed", feeds)
		}
	})

	t.Run("tools/call reports a tool error in-band", func(t *testing.T) {
		// A bad argument is a tool-level failure (isError), not a transport
		// one: the client sees the message and can fix the call.
		res := mcpRPC(t, h, `{"jsonrpc":"2.0","id":4,"method":"tools/call",`+
			`"params":{"name":"srr_list_articles","arguments":{"since":"garbage"}}}`)
		if res["isError"] != true {
			t.Fatalf("isError = %v, want true", res["isError"])
		}
		if !strings.Contains(rawJSON(t, res), "invalid time") {
			t.Errorf("error content does not carry the parse message: %v", res)
		}
	})
}

func rawJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// /mcp lives inside serve's hostGuard, so a DNS-rebinding page (same-origin to
// the browser, but unable to present a loopback Host) is refused before the SDK
// handler ever sees the body.
func TestMCPHTTPNonLoopbackHostForbidden(t *testing.T) {
	setupTestDB(t)
	h := newMux()

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Host = "evil.example.com"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("POST /mcp with non-loopback Host = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}

// The endpoint is registered method-by-method (POST/GET/DELETE) to dodge the
// ServeMux pattern conflict with "GET /": anything else must not fall through
// to the admin UI's file server, which would answer 200 with HTML.
func TestMCPHTTPUnsupportedMethod(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), http.MethodPut, "/mcp", "")
	if rec.Code == http.StatusOK {
		t.Fatalf("PUT /mcp = 200, want a rejection (did it reach the UI file server?): %s", rec.Body)
	}
}

// --- layer 3: stdio-equivalent session --------------------------------------

// The `srr mcp` path exercised without OS pipes: the very same
// newMCPServer().Run a stdio session drives, wired to a real mcp.Client over an
// in-memory transport pair. Pins that the registry a locally-spawned client
// sees is the same one the HTTP endpoint serves.
func TestMCPInMemorySession(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
	seedFeed(t, db, &Feed{Title: "News feed", URL: "https://n.example/f", Tag: "news"})

	clientT, serverT := mcp.NewInMemoryTransports()
	srvErr := make(chan error, 1)
	go func() { srvErr <- newMCPServer().Run(ctx, serverT) }()

	cs, err := mcp.NewClient(&mcp.Implementation{Name: "srr-test", Version: "0"}, nil).
		Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}

	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	names := make([]string, 0, len(tools.Tools))
	for _, tl := range tools.Tools {
		names = append(names, tl.Name)
	}
	slices.Sort(names)
	want := []string{
		"srr_add_feed", "srr_fetch", "srr_list_articles", "srr_overview",
		"srr_preview_feed", "srr_resolve_feed", "srr_update_feed",
	}
	if !slices.Equal(names, want) {
		t.Errorf("tools = %v, want %v", names, want)
	}

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "srr_overview"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("srr_overview reported an error: %s", rawJSON(t, res.Content))
	}
	var got overviewOut
	if err := json.Unmarshal([]byte(rawJSON(t, res.StructuredContent)), &got); err != nil {
		t.Fatalf("decode structured content: %v", err)
	}
	if got.Store.Version != version || len(got.Store.Feeds) != 1 {
		t.Errorf("store snapshot = %+v, want version %q and the one seeded feed", got.Store, version)
	}

	if err := cs.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := <-srvErr; err != nil {
		t.Fatalf("server Run: %v", err)
	}
}
