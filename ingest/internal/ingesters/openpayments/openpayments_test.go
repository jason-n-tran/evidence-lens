package openpayments

import "testing"

func TestNullable(t *testing.T) {
	if nullable("") != nil {
		t.Error("empty should be nil")
	}
	if v := nullable("x"); v != "x" {
		t.Errorf("nullable: %v", v)
	}
}

func TestSafe(t *testing.T) {
	col := map[string]int{"A": 0, "B": 1}
	rec := []string{"a-val", "b-val"}
	if got := safe(rec, col, "A"); got != "a-val" {
		t.Error("safe A")
	}
	if got := safe(rec, col, "Z"); got != "" {
		t.Errorf("safe missing: %q", got)
	}
	if got := safe(rec, col, "B"); got != "b-val" {
		t.Error("safe B")
	}
}

func TestRowToMap(t *testing.T) {
	header := []string{"X", "Y", "Z"}
	rec := []string{"1", "2", "3"}
	m := rowToMap(header, rec)
	if m["Y"] != "2" || m["Z"] != "3" {
		t.Errorf("rowToMap: %v", m)
	}
}
