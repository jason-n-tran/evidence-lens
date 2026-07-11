"""PubMed XML parser. Reference parser — others mirror this shape.

Input: one PubmedArticle XML fragment (as written by ingester-pubmed).
Output: dict matching the canonical Document schema (proto/evidencelens/v1/document.proto).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from lxml import etree


def parse(raw: bytes) -> dict[str, Any]:
    root = etree.fromstring(raw)
    pmid = root.findtext("MedlineCitation/PMID") or ""
    title = root.findtext("MedlineCitation/Article/ArticleTitle") or ""

    abstract_parts = []
    for ab in root.iterfind("MedlineCitation/Article/Abstract/AbstractText"):
        label = ab.get("Label", "")
        text = (ab.text or "").strip()
        if label:
            abstract_parts.append(f"{label}: {text}")
        else:
            abstract_parts.append(text)
    abstract = "\n\n".join(p for p in abstract_parts if p)

    doi = ""
    for aid in root.iterfind("PubmedData/ArticleIdList/ArticleId"):
        if aid.get("IdType") == "doi":
            doi = (aid.text or "").lower()

    pmcid = ""
    for aid in root.iterfind("PubmedData/ArticleIdList/ArticleId"):
        if aid.get("IdType") == "pmc":
            pmcid = (aid.text or "")

    journal_title = root.findtext("MedlineCitation/Article/Journal/Title") or ""
    issn = root.findtext("MedlineCitation/Article/Journal/ISSN") or ""

    # Step 1: read Year/Month/Day separately from JournalIssue/PubDate.
    pub_date_el = root.find("MedlineCitation/Article/Journal/JournalIssue/PubDate")
    pub_str = ""
    if pub_date_el is not None:
        _year = pub_date_el.findtext("Year") or ""
        _month = pub_date_el.findtext("Month") or ""
        _day = pub_date_el.findtext("Day") or ""
        if _year:
            pub_str = " ".join(filter(None, [_year, _month, _day]))
        else:
            pub_str = pub_date_el.findtext("MedlineDate") or ""

    # Step 2: if only year was found, upgrade precision via PubMedHistory.
    # History entries (status "pubmed" or "entrez") always carry full Y/M/D.
    if pub_str and len(pub_str.split()) == 1:
        _MONTH_NUM = {str(v).zfill(2): k for k, v in _MONTHS.items()}
        for hist in root.iterfind("PubmedData/History/PubMedPubDate"):
            if hist.get("PubStatus") in ("pubmed", "entrez"):
                hy = hist.findtext("Year") or ""
                hm = hist.findtext("Month") or ""
                hd = hist.findtext("Day") or ""
                if hy:
                    month_name = _MONTH_NUM.get(hm.zfill(2), hm)
                    pub_str = " ".join(filter(None, [hy, month_name, hd]))
                    break

    published_at = _parse_pubdate(pub_str)

    authors = []
    for author_el in root.iterfind("MedlineCitation/Article/AuthorList/Author"):
        last = author_el.findtext("LastName") or ""
        fore = author_el.findtext("ForeName") or ""
        initials = author_el.findtext("Initials") or ""
        display = (f"{last} {initials}").strip() if last else fore
        affiliation = author_el.findtext("AffiliationInfo/Affiliation") or None
        orcid = None
        for ident in author_el.iterfind("Identifier"):
            if ident.get("Source") == "ORCID":
                orcid = (ident.text or "").strip().split("/")[-1]
        authors.append({
            "display_name": display,
            "given_name": fore or None,
            "family_name": last or None,
            "orcid": orcid,
            "affiliation": affiliation,
            "payments": [],
        })

    mesh = []
    for mh in root.iterfind("MedlineCitation/MeshHeadingList/MeshHeading/DescriptorName"):
        if mh.text:
            mesh.append(mh.text)

    keywords = []
    for kw in root.iterfind("MedlineCitation/KeywordList/Keyword"):
        if kw.text:
            keywords.append(kw.text)

    citations: list[str] = []
    for ref in root.iterfind("PubmedData/ReferenceList/Reference"):
        cited_pmid = ref.findtext("ArticleIdList/ArticleId[@IdType='pubmed']")
        if cited_pmid:
            citations.append(f"pubmed:{cited_pmid.strip()}")

    return {
        "id": f"pubmed:{pmid}",
        "source": "pubmed",
        "source_native_id": pmid,
        "doi": doi or None,
        "pmid": pmid,
        "pmcid": pmcid or None,
        "title": title,
        "abstract": abstract,
        "canonical_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        "published_at": published_at,
        "license": "public-domain",
        "authors": authors,
        "study_type": _infer_study_type(root, mesh),
        "mesh_terms": mesh,
        "keywords": keywords,
        "citations": citations,
        "journal": {
            "name": journal_title,
            "issn": issn or None,
            "is_predatory": False,
        },
    }


def _parse_pubdate(s: str) -> str | None:
    """Best-effort: PubMed mixes 'YYYY', 'YYYY Mon DD', 'YYYY Mon-Mon', etc."""
    if not s:
        return None
    parts = s.split()
    try:
        if len(parts) == 1:
            return f"{int(parts[0]):04d}-01-01T00:00:00Z"
        if len(parts) >= 2:
            year = int(parts[0])
            month = _MONTHS.get(parts[1][:3].lower(), 1)
            day = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else 1
            return f"{year:04d}-{month:02d}-{day:02d}T00:00:00Z"
    except (ValueError, KeyError):
        pass
    return None


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _infer_study_type(root, mesh: list[str]) -> str:
    """Cheap classifier from PublicationType + MeSH. Real classifier
    runs in the entity-linker stage on the full text."""
    pubtypes = {pt.text for pt in root.iterfind("MedlineCitation/Article/PublicationTypeList/PublicationType")}
    if "Randomized Controlled Trial" in pubtypes:
        return "RCT"
    if "Meta-Analysis" in pubtypes:
        return "META_ANALYSIS"
    if "Systematic Review" in pubtypes:
        return "SYSTEMATIC_REVIEW"
    if "Case Reports" in pubtypes:
        return "CASE_REPORT"
    if "Review" in pubtypes:
        return "REVIEW"
    if "Editorial" in pubtypes:
        return "EDITORIAL"
    if "Practice Guideline" in pubtypes or "Guideline" in pubtypes:
        return "GUIDELINE"
    if "Observational Study" in pubtypes:
        return "OBSERVATIONAL"
    return "OTHER"
