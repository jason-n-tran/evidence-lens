"use client";

import { useEffect, useState } from "react";
import { useSearchStore } from "../lib/store";

// Fallback list used only if the /api/facets call fails. Normally the study-type
// options are driven by what's actually in the index (with counts).
const STUDY_TYPES_FALLBACK = ["RCT", "META_ANALYSIS", "SYSTEMATIC_REVIEW", "OBSERVATIONAL", "PREPRINT", "REGULATORY", "GUIDELINE"];
const SORT_MODES = [
  { id: "relevance",        label: "Relevance" },
  { id: "most_recent",      label: "Most recent" },
  { id: "most_cited",       label: "Most cited" },
  { id: "most_influential", label: "Most influential" },
];
