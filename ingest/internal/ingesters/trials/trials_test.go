package trials

import "testing"

func TestGetStudyNCT(t *testing.T) {
	study := map[string]any{
		"protocolSection": map[string]any{
			"identificationModule": map[string]any{
				"nctId": "NCT01234567",
			},
		},
	}
	if got := getStudyNCT(study); got != "NCT01234567" {
		t.Errorf("getStudyNCT: %q", got)
	}
}

func TestGetStudyNCTMissing(t *testing.T) {
	if got := getStudyNCT(map[string]any{}); got != "" {
		t.Errorf("missing should be empty, got %q", got)
	}
}
