package mod

import (
	"context"

	"github.com/tdewolff/minify"
	"github.com/tdewolff/minify/html"
)

func init() {
	Register("minify", func() Processor {
		mi := minify.New()
		mi.AddFunc("text/html", html.Minify)

		return func(_ context.Context, p Params, i *RawItem) error {
			if err := p.only(); err != nil {
				return err
			}
			var err error
			i.Content, err = mi.String("text/html", i.Content)
			return err
		}
	})
}
