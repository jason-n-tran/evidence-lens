package meili

import "testing"

func TestFlattenPromotesFacets(t *testing.T) {
	d := map[string]any{
		"id":              "pubmed:1",
		"title":           "x",
		"published_at":    "2024-03-15T00:00:00Z",
		"study_type":      "RCT",
		"journal":         map[string]any{"name": "NEJM", "is_predatory": false},
		"authors":         []any{map[string]any{"display_name": "Smith J"}},
		"has_coi_authors": true,
		"full_text":       "long text",
	}
	out := flatten(d)
	// Meili ids replace ALL colons with underscores (primary-key constraint).
	if out["id"] != "pubmed_1" || out["study_type"] != "RCT" {
		t.Fatalf("flatten basic: %+v", out)
	}
	if out["canonical_id"] != "pubmed:1" {
		t.Errorf("canonical_id should preserve colon form: %v", out["canonical_id"])
	}
	if out["published_year"] != 2024 {
		t.Errorf("published_year: %v", out["published_year"])
	}
	if out["journal_name"] != "NEJM" {
		t.Errorf("journal_name: %v", out["journal_name"])
	}
	if out["has_full_text"] != true {
		t.Errorf("has_full_text should be true when full_text non-empty")
	}
	names, _ := out["authors_display"].([]string)
	if len(names) != 1 || names[0] != "Smith J" {
		t.Errorf("authors_display: %v", names)
	}
}

func TestFlattenHandlesEmptyFullText(t *testing.T) {
	out := flatten(map[string]any{"id": "x", "full_text": ""})
	if out["has_full_text"] != false {
		t.Error("has_full_text should be false on empty string")
	}
}

// TestFlattenPreservesDetailFields locks the contract that the document/trial
// detail pages depend on. These were silently dropped before (flatten only
// kept facet scalars), which 404'd trial pages and blanked JSON-LD identifiers
// + COI badges. Regression guard: if someone trims flatten again, this fails
// at build time instead of on a user's screen.
func TestFlattenPreservesDetailFields(t *testing.T) {
	d := map[string]any{
		"id":     "pubmed:42",
		"title":  "t",
		"doi":    "10.1/abc",
		"pmid":   "42",
		"pmcid":  "PMC42",
		"nct_id": "NCT00000042",
		"journal": map[string]any{"name": "NEJM", "issn": "0028-4793", "is_predatory": false},
		"trial":  map[string]any{"registry": "ctgov", "status": "recruiting", "phase": "na"},
		"authors": []any{map[string]any{
			"display_name": "Smith J",
			"orcid":        "0000-0002-1825-0097",
			"affiliation":  "Harvard",
			"badge":        map[string]any{"has_payments": true, "total_payments_usd": 1234.0},
		}},
	}
	out := flatten(d)

	for _, k := range []string{"doi", "pmid", "pmcid", "nct_id", "journal", "trial", "authors"} {
		if _, ok := out[k]; !ok {
			t.Errorf("flatten dropped detail field %q — detail page / JSON-LD will render blank", k)
		}
	}
	// journal object must survive whole (detail page reads issn), in addition
	// to the flat journal_name kept for faceting.
	if j, ok := out["journal"].(map[string]any); !ok || j["issn"] != "0028-4793" {
		t.Errorf("journal object/issn not preserved: %v", out["journal"])
	}
	if out["journal_name"] != "NEJM" {
		t.Errorf("flat journal_name should still be set for faceting: %v", out["journal_name"])
	}
	// trial object must survive whole (trial page notFound()s without it).
	if tr, ok := out["trial"].(map[string]any); !ok || tr["registry"] != "ctgov" {
		t.Errorf("trial object not preserved: %v", out["trial"])
	}
	// authors must carry the badge (COIBadge) + orcid, not just names.
	authors, ok := out["authors"].([]any)
	if !ok || len(authors) != 1 {
		t.Fatalf("authors not preserved as objects: %v", out["authors"])
	}
	a0 := authors[0].(map[string]any)
	if a0["orcid"] != "0000-0002-1825-0097" {
		t.Errorf("author orcid dropped: %v", a0)
	}
	if _, ok := a0["badge"].(map[string]any); !ok {
		t.Errorf("author badge dropped — COIBadge can never render: %v", a0)
	}
	// flat name array still present for the result-card byline.
	if names, _ := out["authors_display"].([]string); len(names) != 1 || names[0] != "Smith J" {
		t.Errorf("authors_display byline not preserved: %v", out["authors_display"])
	}
}
