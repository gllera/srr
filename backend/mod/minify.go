package mod

import (
	"github.com/tdewolff/minify"
	"github.com/tdewolff/minify/html"
)

func init() {
	Register("minify", func() func(*RawItem) error {
		mi := minify.New()
		mi.AddFunc("text/html", html.Minify)

		return func(i *RawItem) error {
			var err error
			i.Content, err = mi.String("text/html", i.Content)
			return err
		}
	})
}
