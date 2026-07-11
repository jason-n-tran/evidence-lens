"""Salience-hook extractor (spec §6.7).

Pre-computes a one-line summary like "RCT, n=12,847, 21% reduction in
MACE" at index time so result cards can show it without round-tripping
through an LLM at query time.

Implementation: regex + heuristic over the abstract. Conservative —
emits only when at least one strong signal is found, otherwise None
(the frontend renders nothing). This intentionally trades recall for
precision because a wrong salience would surface incorrect numbers.
"""
from __future__ import annotations

import re
from typing import Optional

# n = 12,847 / N = 12847 / sample size of 12,847
_RE_N = re.compile(
    r"(?:^|[^A-Za-z])(?:n\s*=|N\s*=|sample size\s+of\s+|enrolled\s+|randomi[sz]ed\s+)"
    r"([\d,]{2,9})",
    re.IGNORECASE,
)

# Effect size, two word orders:
#   number-first: "21% reduction", "21% lower", "12% increase"
#   verb-first:   "reduced ... by 21%", "increased ... by 12%"
_RE_PCT = re.compile(r"\b(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(reduction|lower|relative reduction|absolute reduction|increase|higher)", re.IGNORECASE)
_RE_PCT_VERB = re.compile(r"\b(reduc\w*|lower\w*|decreas\w*|increas\w*|rais\w*|higher)\b[^.]*?\bby\s+(\d{1,2}(?:\.\d{1,2})?)\s*%", re.IGNORECASE)
_RE_HR  = re.compile(r"\b(?:HR|hazard ratio|RR|relative risk|OR|odds ratio)\s*=?\s*(\d\.\d{1,3})\b", re.IGNORECASE)
_RE_CI  = re.compile(r"\b(95%?\s*CI[:,]?\s*[\d.,\s\-to]+)\b", re.IGNORECASE)
_RE_P   = re.compile(r"\bp\s*[<=]\s*(0?\.\d{1,4})\b", re.IGNORECASE)

_OUTCOMES = ["mortality", "MACE", "all-cause death", "cardiovascular death",
             "stroke", "myocardial infarction", "hospitalization", "progression",
             "remission", "response rate", "overall survival", "progression-free survival"]


def extract(study_type: str | None, abstract: str | None) -> Optional[str]:
    """Returns a salience hook or None.

    `study_type` is one of the StudyType enum strings; we use it as the
    leading qualifier ("RCT", "Meta-analysis", etc.). `abstract` is
    parsed for n + effect size + outcome.
    """
    if not abstract:
        return None
    parts: list[str] = []

    # 1. Lead with a brief study-type label.
    label = _study_label(study_type or "")
    if label:
        parts.append(label)

    # 2. Sample size.
    m = _RE_N.search(abstract)
    if m:
        n = m.group(1).replace(",", "")
        if n.isdigit() and int(n) >= 10:
            parts.append(f"n={int(n):,}")

    # 3. Effect size. Try number-first ("21% reduction") then verb-first
    #    ("reduced MACE by 21%"); use whichever matches earliest.
    eff = _RE_PCT.search(abstract)
    eff_verb = _RE_PCT_VERB.search(abstract)
    if eff and (not eff_verb or eff.start() <= eff_verb.start()):
        outcome = _find_outcome(abstract, eff.end())
        direction = eff.group(2).lower()
        is_increase = "increase" in direction or "higher" in direction
        phrase = f"{eff.group(1)}% {'increase' if is_increase else 'reduction'}"
        if outcome:
            phrase += f" in {outcome}"
        parts.append(phrase)
    elif eff_verb:
        verb = eff_verb.group(1).lower()
        is_increase = verb.startswith(("increas", "rais", "higher"))
        # Outcome usually sits between the verb and "by N%"; scan that span.
        outcome = _find_outcome(abstract, (eff_verb.start() + eff_verb.end()) // 2)
        phrase = f"{eff_verb.group(2)}% {'increase' if is_increase else 'reduction'}"
        if outcome:
            phrase += f" in {outcome}"
        parts.append(phrase)
    else:
        hr = _RE_HR.search(abstract)
        if hr:
            outcome = _find_outcome(abstract, hr.end())
            phrase = f"HR {hr.group(1)}"
            if outcome:
                phrase += f" for {outcome}"
            parts.append(phrase)

    # 4. p-value.
    p = _RE_P.search(abstract)
    if p:
        parts.append(f"p<{p.group(1)}")

    if len(parts) < 2:
        return None  # Not enough signal — emit nothing rather than mislead.
    return ", ".join(parts)


def _study_label(study_type: str) -> str:
    return {
        "RCT": "RCT",
        "META_ANALYSIS": "Meta-analysis",
        "SYSTEMATIC_REVIEW": "Systematic review",
        "OBSERVATIONAL": "Observational",
        "CASE_REPORT": "Case report",
        "TRIAL_REGISTRY": "Trial",
        "REGULATORY": "Regulatory",
        "GUIDELINE": "Guideline",
    }.get(study_type, "")


def _find_outcome(text: str, near_pos: int, window: int = 80) -> Optional[str]:
    """Find a known outcome term within ±window characters of pos."""
    chunk = text[max(0, near_pos - window): near_pos + window].lower()
    for o in _OUTCOMES:
        if o.lower() in chunk:
            return o
    return None
