package chembl

import "testing"

// Compile-shape smoke. HTTP behavior is replayed from recorded
// fixtures during local dev; see
// ingest/internal/ingesters/pubmed/testdata/README.md for the
// go-vcr cassette pattern adopted by every ingester.
func TestPackageCompiles(t *testing.T) {
	_ = "ok"
}
