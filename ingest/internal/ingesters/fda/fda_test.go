package fda

import "testing"

func TestPickDateField(t *testing.T) {
	if pickDateField("drug/enforcement") != "report_date" {
		t.Error("drug/enforcement should be report_date")
	}
	if pickDateField("device/510k") != "decision_date" {
		t.Error("device/510k should be decision_date")
	}
}

func TestPickID(t *testing.T) {
	got := pickID("drug/enforcement", map[string]any{"recall_number": "F-2026-001"})
	if got != "F-2026-001" {
		t.Errorf("pickID enforcement: %q", got)
	}
	got = pickID("device/510k", map[string]any{"k_number": "K123"})
	if got != "K123" {
		t.Errorf("pickID 510k: %q", got)
	}
}

func TestSanitize(t *testing.T) {
	if sanitize("drug/enforcement") != "drug-enforcement" {
		t.Errorf("sanitize: %q", sanitize("drug/enforcement"))
	}
}
