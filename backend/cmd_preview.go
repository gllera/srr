package main

import (
	"context"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/gllera/srr/backend/mod"
)

type PreviewCmd struct {
	URL  *url.URL `arg:"" help:"RSS feed URL to preview."`
	Pipe []string `short:"p" help:"Pipeline processors to apply."`
	Addr string   `short:"a" default:"localhost:8080" env:"SRR_PREVIEW_ADDR" help:"Address to listen on."`
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

func (o *PreviewCmd) Run() error {
	ctx := context.Background()
	client := &http.Client{Timeout: 10 * time.Second}
	processor := mod.New()

	req, err := http.NewRequestWithContext(ctx, "GET", o.URL.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "SRR/"+version)

	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected HTTP status: %s", res.Status)
	}

	buf := make([]byte, globals.MaxFeedSize*(1<<10)+1)
	n, err := io.ReadFull(res.Body, buf)
	if err == nil {
		return fmt.Errorf("feed bigger than %d bytes", cap(buf)-1)
	}
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("empty response")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}

	var articles []*Item

	err = parseFeed(buf[:n], func(i *mod.RawItem) error {
		if err := processItem(ctx, processor, o.Pipe, i); err != nil {
			return err
		}

		articles = append(articles, &Item{
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: i.Published.Unix(),
		})
		return nil
	})
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
