"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ResultCard } from "./ResultCard";
import { useSearchStore } from "../lib/store";
import { getVariant, getSessionId, logClick } from "../lib/session";

type SortMode = "relevance" | "most_recent" | "most_cited" | "most_influential" | undefined;

interface Result {
  document: any;
  finalScore: number;
  breakdown: any;
}
