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

async function meiliGetDoc(id: string): Promise<unknown> {
  const r = await fetch(
    `${MEILI_URL}/indexes/documents/documents/${encodeURIComponent(id)}`,
    { headers: meiliHeaders() },
  );
  if (!r.ok) return { error: `meilisearch ${r.status}` };
  return r.json();
}

type ToolNeighborNode = { id: string; title: string; pagerank: number; year: string; dir: 'center'|'out'|'in' };

async function neo4jNeighborhood(id: string, depth: number): Promise<unknown> {
  const d = Math.min(Math.max(depth, 1), 3);
  const auth = "Basic " + Buffer.from(
    `${process.env.NEO4J_USER ?? "neo4j"}:${process.env.NEO4J_PASSWORD ?? ""}`,
  ).toString("base64");

  const cypher = {
    statements: [
      {
        // A: center + outbound to depth d
        statement: `
          MATCH (doc:Document {id: $id})
          OPTIONAL MATCH (doc)-[:CITES*1..${d}]->(n:Document)
          WITH DISTINCT doc, n
          RETURN doc.id, doc.title, coalesce(doc.pagerank,0.0), left(coalesce(doc.published_at,''),4),
                 n.id, n.title, coalesce(n.pagerank,0.0), left(coalesce(n.published_at,''),4)
          LIMIT 50`,
        parameters: { id },
      },
      {
        // B: inbound (always 1-hop — who cites this doc directly)
        statement: `
          MATCH (inc:Document)-[:CITES]->(doc:Document {id: $id})
          RETURN inc.id, inc.title, coalesce(inc.pagerank,0.0), left(coalesce(inc.published_at,''),4)
          LIMIT 15`,
        parameters: { id },
      },
      {
        // C: cross-edges between 1-hop outbound neighbours
        statement: `
          MATCH (doc:Document {id: $id})-[:CITES]->(a:Document)-[:CITES]->(b:Document)
          WHERE (doc)-[:CITES]->(b)
          RETURN DISTINCT a.id AS source, b.id AS target
          LIMIT 100`,
        parameters: { id },
      },
    ],
  };

  const r = await fetch(`${NEO4J_HTTP}/db/neo4j/tx/commit`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(cypher),
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) return { error: `neo4j ${r.status}` };

  const data = await r.json() as any;
  const rowsA: any[] = data?.results?.[0]?.data ?? [];
  const rowsB: any[] = data?.results?.[1]?.data ?? [];
  const rowsC: any[] = data?.results?.[2]?.data ?? [];
  if (rowsA.length === 0) return { nodes: [], edges: [] };

  const nodeMap = new Map<string, ToolNeighborNode>();
  const edges: { source: string; target: string }[] = [];

  const [dId, dTitle, dPagerank, dYear] = rowsA[0].row as [string, string, number, string];
  nodeMap.set(dId, { id: dId, title: dTitle ?? id, pagerank: dPagerank ?? 0, year: dYear ?? '', dir: 'center' });

  for (const { row } of rowsA) {
    const [,,,, nId, nTitle, nPagerank, nYear] = row as [string,string,number,string, string|null,string|null,number|null,string|null];
    if (nId) {
      if (!nodeMap.has(nId)) nodeMap.set(nId, { id: nId, title: nTitle ?? nId, pagerank: nPagerank ?? 0, year: nYear ?? '', dir: 'out' });
      edges.push({ source: dId, target: nId });
    }
  }

  for (const { row } of rowsB) {
    const [incId, incTitle, incPagerank, incYear] = row as [string, string, number, string];
    if (!incId) continue;
    if (!nodeMap.has(incId)) nodeMap.set(incId, { id: incId, title: incTitle ?? incId, pagerank: incPagerank ?? 0, year: incYear ?? '', dir: 'in' });
    edges.push({ source: incId, target: dId });
  }

  for (const { row } of rowsC) {
    const [source, target] = row as [string, string];
    if (source && target) edges.push({ source, target });
  }

  const center = nodeMap.get(dId)!;
  const rest = Array.from(nodeMap.values()).filter(n => n.id !== dId);
  return { nodes: [center, ...rest], edges };
}

@Injectable()
export class ToolService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool | null = null;

  constructor(private readonly search: SearchService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.DATABASE_URL) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  // --- tool implementations ---

  async searchEvidence(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? "");
    const filters = normaliseFilters(args.filters);
    const topK = Math.min(Number(args.top_k) || 10, 50);
    return this.search.search(query, filters, topK);
  }

  async getPaper(args: Record<string, unknown>): Promise<unknown> {
    const id = String(args.id ?? "");
    const doc = await meiliGetDoc(id);
    let neighborhood: unknown = null;
    try { neighborhood = await neo4jNeighborhood(id, 1); } catch { /* non-fatal */ }
    return { ...(doc as object), citationNeighborhood: neighborhood };
  }

  async getTrial(args: Record<string, unknown>): Promise<unknown> {
    return meiliGetDoc(String(args.id ?? ""));
  }

  async getTrialsByCondition(args: Record<string, unknown>): Promise<unknown> {
    const { condition, location, status, phase } = args as Record<string, string | undefined>;
    const filter: string[] = [`source IN ["ctgov","ictrp"]`];
    if (status) filter.push(`trial_status = ${JSON.stringify(status.toLowerCase())}`);
    if (phase)  filter.push(`trial_phase  = ${JSON.stringify(phase.toLowerCase())}`);
    const r = await fetch(`${MEILI_URL}/indexes/documents/search`, {
      method: "POST",
      headers: meiliHeaders(),
      body: JSON.stringify({
        q: condition ?? "",
        filter,
        limit: 20,
        attributesToRetrieve: ["id", "title", "abstract", "trial", "publishedAt", "source"],
      }),
    });
    if (!r.ok) return { error: `meilisearch ${r.status}` };
    const data = await r.json() as any;
    const hits = data.hits ?? [];
    const results = location
      ? hits.filter((h: any) =>
          (h.trial?.locations ?? []).some((l: string) =>
            l.toLowerCase().includes(location.toLowerCase())))
      : hits;
    return { condition, location, status, phase, results };
  }

  async getRecentRecalls(args: Record<string, unknown>): Promise<unknown> {
    if (!this.pool) return { events: [], note: "DATABASE_URL not configured" };
    const sinceDays = Math.min(Number(args.since_days) || 30, 365);
    const drugClass   = args.drug_class   ? String(args.drug_class)   : undefined;
    const productName = args.product_name ? String(args.product_name) : undefined;
    const where: string[] = [`emitted_at >= NOW() - ($1::int * INTERVAL '1 day')`];
    const params: unknown[] = [sinceDays];
    if (drugClass)   { params.push(drugClass);   where.push(`drug_class = $${params.length}`); }
    if (productName) { params.push(productName); where.push(`product_name ILIKE $${params.length}`); }
    params.push(50);
    const sql =
      `SELECT id AS recall_id, agency, product_name, drug_class, recall_class, emitted_at
       FROM recall_events
       WHERE ${where.join(" AND ")}
       ORDER BY emitted_at DESC
       LIMIT $${params.length}`;
    const res = await this.pool.query(sql, params);
    return { sinceDays, drugClass, productName, events: res.rows };
  }

  async getAuthorPayments(args: Record<string, unknown>): Promise<unknown> {
    if (!this.pool) return { payments: [], note: "DATABASE_URL not configured" };
    const authorName = String(args.author_name ?? "");
    const year = args.year ? Number(args.year) : undefined;
    const params: unknown[] = [`%${authorName}%`];
    let sql =
      `SELECT * FROM author_payment_cache WHERE author_name ILIKE $1`;
    if (year) { params.push(year); sql += ` AND year = $${params.length}`; }
    sql += " ORDER BY total_amount_usd DESC LIMIT 50";
    const res = await this.pool.query(sql, params);
    return { authorName, year, payments: res.rows };
  }

  async getCitationNeighborhood(args: Record<string, unknown>): Promise<unknown> {
    const id    = String(args.id ?? "");
    const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3);
    return neo4jNeighborhood(id, depth);
  }

  async evaluateEvidenceQuality(args: Record<string, unknown>): Promise<unknown> {
    const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(String).slice(0, 20) : [];
    const docs = await Promise.all(ids.map(id => meiliGetDoc(id)));
    const results = docs.map((d: any, i) => ({
      id: ids[i],
      title:        d?.title        ?? d?.error ?? null,
      studyType:    d?.study_type   ?? d?.studyType   ?? null,
      sampleSize:   d?.sample_size  ?? d?.sampleSize  ?? null,
      publishedAt:  d?.published_at ?? d?.publishedAt ?? null,
      coiFlag:      d?.coi_flag     ?? d?.coiFlag     ?? null,
      canonicalUrl: d?.canonical_url ?? d?.canonicalUrl ?? null,
    }));
    return { results };
  }
}
