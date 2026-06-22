package pubmed

import (
	"strings"
	"testing"
)

func TestSplitArticles(t *testing.T) {
	xml := `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation><PMID Version="1">123</PMID></MedlineCitation>
    <PubmedData><History>
      <PubMedPubDate PubStatus="entrez"><Year>2026</Year><Month>4</Month><Day>1</Day></PubMedPubDate>
    </History></PubmedData>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation><PMID Version="1">456</PMID></MedlineCitation>
    <PubmedData><History>
      <PubMedPubDate PubStatus="entrez"><Year>2026</Year><Month>4</Month><Day>15</Day></PubMedPubDate>
    </History></PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`

	records, maxEDAT := splitArticles([]byte(xml))
	if len(records) != 2 {
		t.Fatalf("want 2 articles, got %d", len(records))
	}
	if records[0].PMID != "123" || records[1].PMID != "456" {
		t.Errorf("PMIDs: got %v", []string{records[0].PMID, records[1].PMID})
	}
	if !strings.Contains(maxEDAT, "2026/04/15") {
		t.Errorf("expected maxEDAT to be 2026/04/15, got %q", maxEDAT)
	}
}

func TestPadDate(t *testing.T) {
	if padDate("4") != "04" || padDate("15") != "15" {
		t.Error("padDate")
	}
}

func TestChunk(t *testing.T) {
	out := chunk([]string{"a", "b", "c", "d", "e"}, 2)
	if len(out) != 3 {
		t.Fatalf("want 3 chunks, got %d", len(out))
	}
	if out[0][0] != "a" || out[2][0] != "e" {
		t.Errorf("chunk content: %v", out)
	}
}
