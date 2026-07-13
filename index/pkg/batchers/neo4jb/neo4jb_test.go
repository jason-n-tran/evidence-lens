// Note: the cypherUpsert query uses FOREACH instead of UNWIND+WITH chains.
// UNWIND on an empty list produces 0 rows, which silently kills all downstream
// clauses (no AUTHORED_BY, TAGGED_WITH, or CITES edges for that document).
// FOREACH is row-count-neutral so documents with no mesh terms still get
// their author and citation edges written.
package neo4jb

import (
	"encoding/json"
	"testing"
)

func TestFlattenIncludesCitations(t *testing.T) {
	d := docNode{
		ID:        "pubmed:1",
		Title:     "Test",
		Source:    "pubmed",
		Citations: []string{"pubmed:9999", "pubmed:8888"},
	}
	out := flatten([]docNode{d})
	if len(out) != 1 {
		t.Fatalf("expected 1 row, got %d", len(out))
	}
	row := out[0]
	cits, ok := row["citations"].([]string)
	if !ok {
		t.Fatalf("citations not []string: %T %v", row["citations"], row["citations"])
	}
	if len(cits) != 2 || cits[0] != "pubmed:9999" || cits[1] != "pubmed:8888" {
		t.Errorf("unexpected citations: %v", cits)
	}
}

func TestFlattenNilCitationsProducesEmptySlice(t *testing.T) {
	d := docNode{ID: "pubmed:2", Title: "No refs", Source: "pubmed"}
	out := flatten([]docNode{d})
	row := out[0]
	cits := row["citations"]
	// nil and [] are both acceptable — Cypher coalesce handles nil gracefully.
	if cits != nil {
		if c, ok := cits.([]string); ok && len(c) != 0 {
			t.Errorf("expected nil or empty citations, got %v", c)
		}
	}
}

func TestSubmitUnmarshalPopulatesCitations(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"id":        "pubmed:3",
		"title":     "T",
		"source":    "pubmed",
		"citations": []string{"pubmed:111", "pubmed:222"},
	})
	var d docNode
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(d.Citations) != 2 {
		t.Errorf("expected 2 citations after unmarshal, got %d: %v", len(d.Citations), d.Citations)
	}
	if d.Citations[0] != "pubmed:111" {
		t.Errorf("unexpected citation[0]: %s", d.Citations[0])
	}
}
