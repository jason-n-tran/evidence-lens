# PubMed test fixtures

`esearch_sample.xml` and `efetch_sample.xml` are tiny synthetic but
shape-correct samples of NCBI E-utilities responses. They drive the
parser tests in `pubmed_test.go` without making network calls.

When recording new fixtures from real upstream calls, prefer
[go-vcr](https://github.com/dnaeon/go-vcr) cassettes (one round-trip
per cassette under `testdata/cassettes/`) so the HTTP transport
behavior is replayed verbatim.
