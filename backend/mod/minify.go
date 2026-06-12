package mod

import (
	"context"

	"github.com/tdewolff/minify"
	"github.com/tdewolff/minify/html"
)

func init() {
	Register("minify", func(_ Assets) func(context.Context, *RawItem) error {
		mi := minify.New()
		mi.AddFunc("text/html", html.Minify)

		return func(_ context.Context, i *RawItem) error {
			var err error
			i.Content, err = mi.String("text/html", i.Content)
			return err
		}
	})
}
