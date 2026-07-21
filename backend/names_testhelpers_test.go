package main

// Test-side name resolution. Under the generation-manifest model a key is
// LISTED, never derived, so a test that wants "the tail idx pack" or "finalized
// data pack 3" asks the store's own name table exactly like production does —
// these are three one-line spellings of that, not a second naming model.

func tailK(c *DBCore, series string) string { return c.Names.tailKey(series) }

func posK(c *DBCore, series string, pos int) string {
	key, err := c.Names.key(series, pos)
	if err != nil {
		return ""
	}
	return key
}

// deltaK is the i-th live delta segment, oldest first.
func deltaK(c *DBCore, i int) string {
	keys := c.Names.Deltas.keys()
	if i < 0 || i >= len(keys) {
		return ""
	}
	return keys[i]
}

// lastDeltaK is the newest live delta segment — what the retired
// deltaKey(c.Seq) spelling meant.
func lastDeltaK(c *DBCore) string { return deltaK(c, len(c.Names.Deltas.Stems)-1) }
