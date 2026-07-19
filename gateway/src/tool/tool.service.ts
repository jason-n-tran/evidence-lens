import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";
import { SearchService, SearchFilters } from "../search/search.service.js";

const MEILI_URL = process.env.MEILI_URL ?? "http://meilisearch:7700";
const MEILI_KEY = process.env.MEILI_KEY ?? "";
const NEO4J_HTTP = process.env.NEO4J_HTTP_URL ?? "http://neo4j:7474";

// Shape emitted by the WebLLM model's filter array.
interface ModelFilter { field: string; values: string[] }

function normaliseFilters(raw: unknown): SearchFilters | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: SearchFilters = {};
  for (const f of raw as ModelFilter[]) {
    if (!f?.field || !Array.isArray(f.values)) continue;
    switch (f.field) {
      case "study_type":
        out.studyTypes = f.values;
        break;
      case "recency": {
        // Accept "2022" or "2020-2022"
        const parts = String(f.values[0] ?? "").split("-").map(Number).filter(Boolean);
        if (parts.length === 2) { out.publishedYearMin = parts[0]; out.publishedYearMax = parts[1]; }
        else if (parts.length === 1) { out.publishedYearMin = parts[0]; out.publishedYearMax = parts[0]; }
        break;
      }
      case "mesh_terms": out.meshTerms = f.values; break;
      case "source":    out.sources   = f.values; break;
      case "only_with_coi": out.onlyWithCoi = true; break;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function meiliHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (MEILI_KEY) h.authorization = `Bearer ${MEILI_KEY}`;
  return h;
}
