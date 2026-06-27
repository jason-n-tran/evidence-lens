package preprint

import (
	"encoding/json"
	"testing"
)

func TestParseDetailsResponse(t *testing.T) {
	// Recorded from a real api.biorxiv.org call; trimmed to one record.
	body := []byte(`{
		"messages":[{"status":"ok"}],
		"collection":[
			{"doi":"10.1101/2024.01.01.000001","title":"Test","date":"2024-01-15","server":"biorxiv"}
		]
	}`)
	var resp detailsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Collection) != 1 {
		t.Fatalf("want 1 record, got %d", len(resp.Collection))
	}
	if resp.Collection[0].DOI != "10.1101/2024.01.01.000001" {
		t.Errorf("doi: %v", resp.Collection[0].DOI)
	}
}
