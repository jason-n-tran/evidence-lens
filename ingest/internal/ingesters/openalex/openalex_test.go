package openalex

import "testing"

func TestOpenalexShortID(t *testing.T) {
	cases := map[string]string{
		"https://openalex.org/W12345678": "W12345678",
		"openalex.org/W12345678":         "W12345678",
		"W12345678":                      "W12345678",
		"":                               "",
	}
	for in, want := range cases {
		if got := openalexShortID(in); got != want {
			t.Errorf("openalexShortID(%q) = %q, want %q", in, got, want)
		}
	}
}
