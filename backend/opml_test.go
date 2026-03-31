package main

import (
	"os"
	"testing"
)

func TestParseOPMLTreeGrouped(t *testing.T) {
	content := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<body>
	<outline title="Tech" text="Tech">
		<outline title="Blog A" xmlUrl="http://example.com/a.xml"/>
		<outline title="Blog B" xmlUrl="http://example.com/b.xml"/>
	</outline>
	<outline title="News" text="News">
		<outline title="News C" xmlUrl="http://example.com/c.xml"/>
	</outline>
</body>
</opml>`

	f := writeTempFile(t, content)
	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}

	if len(nodes) != 2 {
		t.Fatalf("got %d root nodes, want 2", len(nodes))
	}

	tech := nodes[0]
	if tech.Name != "Tech" {
		t.Errorf("first group name = %q, want %q", tech.Name, "Tech")
	}
	if len(tech.Children) != 2 {
		t.Fatalf("Tech children: got %d, want 2", len(tech.Children))
	}
	if tech.Children[0].Sub.URL != "http://example.com/a.xml" {
		t.Errorf("first tech URL = %q", tech.Children[0].Sub.URL)
	}

	news := nodes[1]
	if len(news.Children) != 1 {
		t.Errorf("News children: got %d, want 1", len(news.Children))
	}
}

func TestParseOPMLTreeFlat(t *testing.T) {
	content := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<body>
	<outline title="Direct Feed" xmlUrl="http://example.com/feed.xml"/>
</body>
</opml>`

	f := writeTempFile(t, content)
	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}

	if len(nodes) != 1 {
		t.Fatalf("got %d root nodes, want 1", len(nodes))
	}
	if nodes[0].Sub == nil {
		t.Fatal("expected subscription on root node")
	}
	if nodes[0].Sub.Title != "Direct Feed" {
		t.Errorf("title = %q, want %q", nodes[0].Sub.Title, "Direct Feed")
	}
}

func TestParseOPMLTreeInvalidURL(t *testing.T) {
	content := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<body>
	<outline title="No URL"/>
	<outline title="Valid" xmlUrl="http://example.com/feed.xml"/>
</body>
</opml>`

	f := writeTempFile(t, content)
	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}

	if len(nodes) != 1 {
		t.Fatalf("got %d root nodes, want 1 (invalid URL should be skipped)", len(nodes))
	}
}

func TestParseOPMLTreeTextFallback(t *testing.T) {
	content := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<body>
	<outline text="Text Only Group">
		<outline text="Text Feed" xmlUrl="http://example.com/feed.xml"/>
	</outline>
</body>
</opml>`

	f := writeTempFile(t, content)
	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}

	if len(nodes) != 1 {
		t.Fatalf("got %d root nodes, want 1", len(nodes))
	}
	if nodes[0].Name != "Text Only Group" {
		t.Errorf("group name = %q, want %q", nodes[0].Name, "Text Only Group")
	}
	if len(nodes[0].Children) != 1 {
		t.Fatalf("group children: got %d, want 1", len(nodes[0].Children))
	}
	if nodes[0].Children[0].Sub.Title != "Text Feed" {
		t.Errorf("title = %q, want %q", nodes[0].Children[0].Sub.Title, "Text Feed")
	}
}

func TestParseOPMLTreeNested(t *testing.T) {
	content := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<body>
	<outline title="Tech">
		<outline title="Blogs">
			<outline title="Deep Blog" xmlUrl="http://example.com/deep.xml"/>
		</outline>
		<outline title="Top Feed" xmlUrl="http://example.com/top.xml"/>
	</outline>
</body>
</opml>`

	f := writeTempFile(t, content)
	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}

	if len(nodes) != 1 {
		t.Fatalf("got %d root nodes, want 1", len(nodes))
	}
	tech := nodes[0]
	if len(tech.Children) != 2 {
		t.Fatalf("Tech children: got %d, want 2", len(tech.Children))
	}

	// Find the Blogs group and Top Feed leaf
	var blogs, topFeed *OPMLNode
	for _, c := range tech.Children {
		if c.Name == "Blogs" {
			blogs = c
		}
		if c.Name == "Top Feed" {
			topFeed = c
		}
	}

	if blogs == nil || len(blogs.Children) != 1 {
		t.Fatal("expected Blogs group with 1 child")
	}
	if blogs.Children[0].Sub.Title != "Deep Blog" {
		t.Errorf("nested feed title = %q, want %q", blogs.Children[0].Sub.Title, "Deep Blog")
	}

	if topFeed == nil || topFeed.Sub == nil {
		t.Fatal("expected Top Feed as leaf subscription")
	}
	if topFeed.Sub.URL != "http://example.com/top.xml" {
		t.Errorf("top feed URL = %q", topFeed.Sub.URL)
	}
}

func TestNormalizeGroupName(t *testing.T) {
	tests := []struct {
		input string
		want  string
		err   bool
	}{
		{"Tech", "tech", false},
		{"My Blog", "my_blog", false},
		{"web-dev", "web_dev", false},
		{"Hello World!", "hello_world", false},
		{"café", "caf", false},
		{"", "", true},
		{"123", "", true},
		{"@#$", "", true},
	}

	for _, tt := range tests {
		got, err := normalizeGroupName(tt.input)
		if (err != nil) != tt.err {
			t.Errorf("normalizeGroupName(%q): err = %v, wantErr = %v", tt.input, err, tt.err)
			continue
		}
		if got != tt.want {
			t.Errorf("normalizeGroupName(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func writeTempFile(t *testing.T, content string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "*.opml")
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(content)
	f.Close()
	return f.Name()
}

func TestParseOPMLFileNotFound(t *testing.T) {
	_, err := ParseOPMLTree("/nonexistent/path/to/file.opml")
	if err == nil {
		t.Error("expected error for non-existent file")
	}
}

func TestParseOPMLInvalidXML(t *testing.T) {
	f := writeTempFile(t, "<<<not xml at all>>>")
	_, err := ParseOPMLTree(f)
	if err == nil {
		t.Error("expected error for invalid XML")
	}
}

func TestParseOPMLEmptyBody(t *testing.T) {
	f := writeTempFile(t, `<?xml version="1.0"?>
<opml version="2.0">
<body>
</body>
</opml>`)

	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}
	if len(nodes) != 0 {
		t.Errorf("got %d nodes, want 0", len(nodes))
	}
}

func TestOutlineToSubBadURLs(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantNil bool
	}{
		{"empty URL", "", true},
		{"no scheme", "example.com/feed.xml", true},
		{"no host", "http:///feed.xml", true},
		{"valid HTTP", "http://example.com/feed.xml", false},
		{"valid HTTPS", "https://example.com/feed.xml", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := Outline{XMLURL: tt.url, Title: "Test"}
			s := outlineToSub(o)
			if (s == nil) != tt.wantNil {
				t.Errorf("outlineToSub(%q) nil=%v, want nil=%v", tt.url, s == nil, tt.wantNil)
			}
		})
	}
}

func TestOutlineDisplayName(t *testing.T) {
	tests := []struct {
		title string
		text  string
		want  string
	}{
		{"My Title", "My Text", "My Title"},
		{"", "Fallback Text", "Fallback Text"},
		{"", "", ""},
		{"Title Only", "", "Title Only"},
	}

	for _, tt := range tests {
		o := Outline{Title: tt.title, Text: tt.text}
		got := outlineDisplayName(o)
		if got != tt.want {
			t.Errorf("outlineDisplayName(title=%q, text=%q) = %q, want %q", tt.title, tt.text, got, tt.want)
		}
	}
}

func TestResolveTag(t *testing.T) {
	tests := []struct {
		path []string
		want string
		err  bool
	}{
		{nil, "", false},
		{[]string{}, "", false},
		{[]string{"Tech"}, "tech", false},
		{[]string{"Tech", "Blogs"}, "tech/blogs", false},
		{[]string{"My Group", "Sub Group"}, "my_group/sub_group", false},
		{[]string{"123"}, "", true},         // numeric-only
		{[]string{"Tech", "###"}, "", true}, // invalid segment
	}

	for _, tt := range tests {
		got, err := resolveTag(tt.path)
		if (err != nil) != tt.err {
			t.Errorf("resolveTag(%v): err=%v, wantErr=%v", tt.path, err, tt.err)
			continue
		}
		if got != tt.want {
			t.Errorf("resolveTag(%v) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestParseOPMLGroupWithSub(t *testing.T) {
	// A group node that itself has a subscription URL plus children
	f := writeTempFile(t, `<?xml version="1.0"?>
<opml version="2.0">
<body>
  <outline title="Group Feed" xmlUrl="http://example.com/group.xml">
    <outline title="Child Feed" xmlUrl="http://example.com/child.xml"/>
  </outline>
</body>
</opml>`)

	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}

	if len(nodes) != 1 {
		t.Fatalf("got %d root nodes, want 1", len(nodes))
	}
	// The node should have both a Sub and Children
	if nodes[0].Sub == nil {
		t.Error("expected group node to have a subscription")
	}
	if len(nodes[0].Children) != 1 {
		t.Errorf("expected 1 child, got %d", len(nodes[0].Children))
	}
}

func TestParseOPMLNodeWithoutSubOrChildren(t *testing.T) {
	// An outline with no URL and no children should be filtered out
	f := writeTempFile(t, `<?xml version="1.0"?>
<opml version="2.0">
<body>
  <outline title="Empty Node"/>
  <outline title="Valid" xmlUrl="http://example.com/feed.xml"/>
</body>
</opml>`)

	nodes, err := ParseOPMLTree(f)
	if err != nil {
		t.Fatalf("ParseOPMLTree: %v", err)
	}

	if len(nodes) != 1 {
		t.Fatalf("got %d root nodes, want 1 (empty node should be filtered)", len(nodes))
	}
	if nodes[0].Name != "Valid" {
		t.Errorf("name = %q, want %q", nodes[0].Name, "Valid")
	}
}
