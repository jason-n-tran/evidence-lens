// MCP tool catalog.
//
// Exposed by mcp-server (TypeScript) over stdio + Streamable HTTP (and legacy
// HTTP+SSE) per Anthropic Model Context Protocol. Public endpoint (proxied by
// the gateway):
//   https://evidencelens.mykpoplists.com/mcp
// Discovery:
//   https://evidencelens.mykpoplists.com/.well-known/mcp.json
//
// Each tool definition below is the **frozen contract**. Tool input
// schemas are JSON Schema draft 2020-12. Implementations dispatch via
// HTTP POST to gateway `/api/tool/{name}` (see docs/api/openapi.yaml).
//
// Spec source of truth: docs/EVIDENCELENS_SPEC.md sections 5.8 and 7.4.
// Any change to a tool name, argument shape, or output shape requires an
// `rfc-interface` PR (see docs/rfcs/README.md).

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const TOOLS: ReadonlyArray<Tool> = [
  {
    name: "search_evidence",
    description:
      "Hybrid biomedical search across PubMed, preprints, clinical trials, " +
      "regulatory data, and CMS Open Payments. Returns ranked Documents with " +
      "conflict-of-interest badges. Supports facet filters by study type, " +
      "publication year range, MeSH terms, source, license, and COI status.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Free-text natural-language query.",
        },
        filters: {
          type: "object",
          properties: {
            study_types: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "RCT",
                  "META_ANALYSIS",
                  "SYSTEMATIC_REVIEW",
                  "OBSERVATIONAL",
                  "CASE_REPORT",
                  "PREPRINT",
                  "TRIAL_REGISTRY",
                  "REGULATORY",
                  "GUIDELINE",
                  "REVIEW",
                  "EDITORIAL",
                  "OTHER",
                ],
              },
            },
            published_year_min: { type: "integer", minimum: 1900 },
            published_year_max: { type: "integer", minimum: 1900 },
            mesh_terms: { type: "array", items: { type: "string" } },
            sources: { type: "array", items: { type: "string" } },
            licenses: { type: "array", items: { type: "string" } },
            only_with_coi: { type: "boolean", default: false },
            only_with_full_text: { type: "boolean", default: false },
            exclude_predatory_journals: { type: "boolean", default: false },
          },
          additionalProperties: false,
        },
        top_k: {
          type: "integer",
          default: 20,
          minimum: 1,
          maximum: 200,
          description: "Maximum results to return.",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "get_paper",
    description:
      "Fetch one document by its canonical EvidenceLens id (e.g. " +
      "'pubmed:12345678', 'biorxiv:10.1101/2024.01.01.000001'). Returns the " +
      "full Document including abstract, full text (when license permits), " +
      "authors with COI badges, MeSH terms, and citation metrics.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description:
            "Canonical id, namespaced as '{source}:{native_id}'. " +
            "Examples: 'pubmed:12345678', 'nct:NCT01234567', " +
            "'fda-recall:F-2026-00123'.",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "get_trial",
    description:
      "Fetch one clinical trial by NCT id (ClinicalTrials.gov) or ICTRP id. " +
      "Returns the trial's status, phase, conditions, interventions, " +
      "locations, enrollment, and primary outcome.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description:
            "NCT id (e.g. 'NCT01234567') or ICTRP id with registry prefix " +
            "(e.g. 'ictrp:eu-ctis:2024-500001').",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "get_trials_by_condition",
    description:
      "Search clinical trials by medical condition. Filters by recruiting " +
      "status, location (city/region/country), and phase. Returns trials " +
      "from both ClinicalTrials.gov and WHO ICTRP.",
    inputSchema: {
      type: "object",
      required: ["condition"],
      properties: {
        condition: {
          type: "string",
          description: "Medical condition (e.g. 'heart failure', 'glioblastoma').",
        },
        location: {
          type: "string",
          description: "City, region, or country.",
        },
        status: {
          type: "string",
          enum: [
            "recruiting",
            "active_not_recruiting",
            "completed",
            "terminated",
            "suspended",
            "withdrawn",
            "unknown",
          ],
        },
        phase: {
          type: "string",
          enum: [
            "early_phase_1",
            "phase_1",
            "phase_2",
            "phase_3",
            "phase_4",
            "not_applicable",
          ],
        },
        top_k: { type: "integer", default: 20, minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },

  {
    name: "get_recent_recalls",
    description:
      "Look up recent FDA / EMA / etc. recall events. Filter by drug class " +
      "(e.g. 'SGLT2', 'ACE inhibitor') or specific product name. Returns " +
      "recalls newest-first.",
    inputSchema: {
      type: "object",
      properties: {
        drug_class: { type: "string" },
        product_name: { type: "string" },
        since_days: { type: "integer", default: 30, minimum: 1, maximum: 365 },
        top_k: { type: "integer", default: 20, minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },

  {
    name: "get_author_payments",
    description:
      "Look up CMS Open Payments records for an author. Returns matched " +
      "payments (sponsor, year, amount, type) sorted by amount descending. " +
      "Matching uses fuzzy name comparison with a conservative threshold (≥0.90); " +
      "false positives are possible but rare. Always verify against the CMS " +
      "Open Payments search tool for clinical decisions.",
    inputSchema: {
      type: "object",
      required: ["author_name"],
      properties: {
        author_name: {
          type: "string",
          description: "Full author name as it appears in the publication.",
        },
        year: {
          type: "string",
          description:
            "Specific year (e.g. '2024') or range ('2020-2024'). Default: " +
            "all years on file.",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "get_citation_neighborhood",
    description:
      "Walk the citation graph outward from one document. Returns the set of " +
      "papers it cites (outbound) and papers that cite it (inbound), up to " +
      "the requested depth. Useful for literature-review expansion.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Canonical document id (see get_paper).",
        },
        depth: {
          type: "integer",
          default: 1,
          minimum: 1,
          maximum: 3,
          description:
            "Hops in the citation graph. Depth 2 typically returns 50–500 " +
            "neighbors; depth 3 can return thousands.",
        },
        top_k_per_hop: {
          type: "integer",
          default: 50,
          minimum: 1,
          maximum: 500,
          description:
            "Cap on neighbors returned per hop (sorted by citation pagerank).",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "evaluate_evidence_quality",
    description:
      "Compute an evidence-quality scorecard for a set of documents. " +
      "Returns per-document scores for: study type strength (RCT > meta > " +
      "observational > case report), recency, citation count, COI presence, " +
      "and journal predatory-status flag. Caller can use this to rank " +
      "their own synthesis or surface caveats to users.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: {
        ids: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string" },
          description: "List of canonical document ids to evaluate.",
        },
      },
      additionalProperties: false,
    },
  },
];

// MCP resource catalog. Documents are addressable as resources so MCP
// clients can include them as context without re-fetching via tool calls.
export const RESOURCE_URI_TEMPLATE = "evidencelens://document/{id}";
