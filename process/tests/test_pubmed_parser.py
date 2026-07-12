"""Tests for the PubMed XML parser."""
from __future__ import annotations

import unittest

from parsers.pubmed import parse

_MINIMAL_XML = b"""<PubmedArticle>
  <MedlineCitation>
    <PMID>12345678</PMID>
    <Article>
      <ArticleTitle>Test Article</ArticleTitle>
      <Abstract><AbstractText>Some abstract.</AbstractText></Abstract>
      <Journal>
        <Title>Test Journal</Title>
        <JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue>
      </Journal>
      <AuthorList>
        <Author><LastName>Smith</LastName><Initials>J</Initials></Author>
      </AuthorList>
      <PublicationTypeList>
        <PublicationType>Journal Article</PublicationType>
      </PublicationTypeList>
    </Article>
  </MedlineCitation>
  <PubmedData>
    <ArticleIdList>
      <ArticleId IdType="pubmed">12345678</ArticleId>
      <ArticleId IdType="doi">10.1234/test</ArticleId>
    </ArticleIdList>
    <ReferenceList>
      <Reference>
        <ArticleIdList>
          <ArticleId IdType="pubmed">11111111</ArticleId>
        </ArticleIdList>
      </Reference>
      <Reference>
        <ArticleIdList>
          <ArticleId IdType="pubmed">22222222</ArticleId>
        </ArticleIdList>
      </Reference>
      <Reference>
        <ArticleIdList>
          <ArticleId IdType="doi">10.9999/no-pmid</ArticleId>
        </ArticleIdList>
      </Reference>
    </ReferenceList>
  </PubmedData>
</PubmedArticle>"""

_NO_REFERENCES_XML = b"""<PubmedArticle>
  <MedlineCitation>
    <PMID>99999999</PMID>
    <Article>
      <ArticleTitle>No refs</ArticleTitle>
      <Journal><Title>J</Title><JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue></Journal>
      <PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList>
    </Article>
  </MedlineCitation>
  <PubmedData>
    <ArticleIdList><ArticleId IdType="pubmed">99999999</ArticleId></ArticleIdList>
  </PubmedData>
</PubmedArticle>"""


class PubmedParserTest(unittest.TestCase):
    def test_citations_extracted_when_reference_list_present(self):
        doc = parse(_MINIMAL_XML)
        self.assertIn("citations", doc)
        self.assertIn("pubmed:11111111", doc["citations"])
        self.assertIn("pubmed:22222222", doc["citations"])

    def test_reference_without_pmid_is_excluded(self):
        doc = parse(_MINIMAL_XML)
        for c in doc["citations"]:
            self.assertTrue(c.startswith("pubmed:"), f"unexpected citation: {c}")

    def test_citations_count(self):
        doc = parse(_MINIMAL_XML)
        self.assertEqual(len(doc["citations"]), 2)

    def test_citations_empty_when_no_reference_list(self):
        doc = parse(_NO_REFERENCES_XML)
        self.assertEqual(doc.get("citations", []), [])

    def test_existing_fields_unaffected(self):
        doc = parse(_MINIMAL_XML)
        self.assertEqual(doc["id"], "pubmed:12345678")
        self.assertEqual(doc["source"], "pubmed")
        self.assertEqual(doc["title"], "Test Article")
        self.assertEqual(doc["doi"], "10.1234/test")

    def test_citation_ids_are_namespaced(self):
        doc = parse(_MINIMAL_XML)
        for c in doc["citations"]:
            self.assertRegex(c, r"^pubmed:\d+$")


if __name__ == "__main__":
    unittest.main()
