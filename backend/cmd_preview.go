package main

import (
	"context"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"time"

	"srrb/ingest"
	"srrb/mod"
)

type PreviewCmd struct {
	URL    *url.URL `arg:"" help:"URL to preview."`
	Recipe string   `short:"r" default:"default" help:"Preview as if the feed used this recipe."`
	Pipe   []string `short:"p" sep:"none" help:"Ad-hoc pipeline override (repeat -p per step), like a feed-level pipe: overrides the recipe's pipe; #default expands to the recipe's effective pipe."`
	Ingest string   `short:"i" help:"Ad-hoc ingest override, like a feed-level ingest: built-in ('#feed') or shell command. Overrides the recipe's ingest."`
	Addr   string   `short:"a" default:"localhost:8080" env:"SRR_PREVIEW_ADDR" help:"Address to listen on."`
}

var previewTmpl = template.Must(template.New("preview").Funcs(template.FuncMap{
	"rawHTML":  func(s string) template.HTML { return template.HTML(s) },
	"unixTime": func(ts int64) string { return time.Unix(ts, 0).UTC().Format("2006-01-02 15:04:05 UTC") },
}).Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8' fill='%23f26522'><circle cx='1' cy='7' r='1'/><path d='M0 3v1a4 4 0 014 4h1A5 5 0 000 3z'/><path d='M0 0v1a7 7 0 017 7h1A8 8 0 000 0z'/></svg>" />
<title>SRR - Preview</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 800px; margin: 0 auto; padding: 1em; font-family: sans-serif; }
  article { border-bottom: 1px solid #ccc; padding: 1em 0; }
  article:last-child { border-bottom: none; }
  .meta { color: #666; font-size: 0.85em; }
  h2 { margin: 0 0 0.3em; }
  h2 a { text-decoration: none; color: #1a0dab; }
  h2 a:hover { text-decoration: underline; }
  .content { margin-top: 0.5em; line-height: 1.5; overflow-wrap: break-word; word-break: break-word; }
  .content img { max-width: 100%; height: auto; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e0e0e0; }
    h2 a { color: #8ab4f8; }
    .meta { color: #999; }
    article { border-color: #444; }
  }
</style>
</head>
<body>
<main>
{{if not .}}<p>No articles found.</p>{{else}}
{{range .}}
<article>
  <h2>{{if .Link}}<a href="{{.Link}}">{{.Title}}</a>{{else}}{{.Title}}{{end}}</h2>
  <div class="meta">{{unixTime .Published}}</div>
  <div class="content">{{rawHTML .Content}}</div>
</article>
{{end}}
{{end}}
</main>
</body>
</html>`))

// previewFetch runs the ingest half of a preview/resolve probe: it resolves
// the effective ingest strategy (ingestOverride acting as a feed-level
// override over the recipe's, over the default's) and fetches rawURL through
// it on a one-shot client. Shared by renderPreview (which then runs the
// pipeline) and serve's handleResolve (which only reads the wire's metadata).
func previewFetch(ctx context.Context, recipes map[string]Recipe, recipeName, ingestOverride, rawURL string) (ingest.Result, error) {
	client := newFetchClient(1)
	// One-shot per probe; the serve process calls this per request, so reclaim
	// the transport's idle keep-alive sockets instead of leaking them ~90s each.
	defer client.CloseIdleConnections()
	engine := ingest.New()

	r := recipeFor(recipes, recipeName)
	def := recipeFor(recipes, defaultRecipeName)
	buf := make([]byte, globals.MaxFeedSize*(1<<10)+1)
	name := ingest.Select(ingestOverride, r.Ingest, def.Ingest)
	result, err := engine.Fetch(ctx, name, client, buf, ingest.Request{URL: rawURL, MaxSize: cap(buf) - 1})
	if err != nil {
		return ingest.Result{}, fmt.Errorf("ingest %q: %w", name, err)
	}
	return result, nil
}

// renderPreview fetches url through the resolved recipe's ingest, runs the
// module pipeline, and returns the processed articles. Shared by PreviewCmd
// (HTML page) and GET /api/preview (JSON). Optional ad-hoc overrides with
// feed-level semantics (the same resolution Feed.Fetch applies to a feed's
// own Ingest/Pipe): a non-empty pipeOverride replaces the recipe's effective
// pipe, #default inside it expanding to that pipe; a non-empty ingestOverride
// wins over the recipe's ingest.
func renderPreview(ctx context.Context, recipes map[string]Recipe, recipeName string, pipeOverride []string, ingestOverride, rawURL string) ([]*Item, error) {
	processor := mod.New()

	r := recipeFor(recipes, recipeName)
	def := recipeFor(recipes, defaultRecipeName)
	pipe := resolvePipe(resolvePipe(def.Pipe, r.Pipe), pipeOverride)
	if err := processor.Validate(ctx, pipe); err != nil {
		return nil, fmt.Errorf("invalid pipeline %v: %w", pipe, err)
	}

	result, err := previewFetch(ctx, recipes, recipeName, ingestOverride, rawURL)
	if err != nil {
		return nil, err
	}

	articles := make([]*Item, 0, len(result.Items))
	for _, i := range result.Items {
		if i == nil {
			continue
		}
		if err := processItem(ctx, processor, pipe, i); err != nil {
			return nil, err
		}
		if i.Drop {
			continue
		}
		var pub int64
		if i.Published != nil {
			pub = i.Published.Unix()
		}
		articles = append(articles, &Item{Title: i.Title, Content: i.Content, Link: i.Link, Published: pub})
	}
	return articles, nil
}

func (o *PreviewCmd) Run() error {
	var recipes map[string]Recipe
	if err := withDB(false, func(_ context.Context, db *DB) error {
		recipes = db.core.Recipes
		return nil
	}); err != nil {
		return err
	}

	ctx := context.Background()
	articles, err := renderPreview(ctx, recipes, o.Recipe, o.Pipe, o.Ingest, o.URL.String())
	if err != nil {
		return err
	}

	fmt.Printf("Serving %d articles at http://%s\n", len(articles), o.Addr)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := previewTmpl.Execute(w, articles); err != nil {
			log.Println("template error:", err)
		}
	})
	return http.ListenAndServe(o.Addr, mux)
}
