import { Controller, Get, HttpException, HttpStatus, Module, NotFoundException, Param } from "@nestjs/common";
import { CacheService } from "../cache/cache.module.js";

const MEILI_URL = process.env.MEILI_URL ?? "http://meilisearch:7700";
const MEILI_KEY = process.env.MEILI_KEY ?? "";
const NEO4J_HTTP = process.env.NEO4J_HTTP_URL ?? "http://neo4j:7474";
// A document (incl. its citation neighborhood) changes only on re-index, while
// the drawer/detail page can be hit repeatedly. Cache the assembled response.
const DOC_TTL_SEC = Number(process.env.DOCUMENT_CACHE_TTL_SEC ?? 300);

@Controller("api/document")
class DocumentController {
  constructor(private readonly cache: CacheService) {}

  @Get(":id")
  async byId(@Param("id") id: string) {
    // NotFound/upstream errors thrown by the loader propagate uncached.
    return this.cache.getOrSet(`doc:v1:${id}`, DOC_TTL_SEC, () => this.assemble(id));
  }

  private async assemble(id: string) {
    const headers: Record<string, string> = {};
    if (MEILI_KEY) headers.authorization = `Bearer ${MEILI_KEY}`;
    const r = await fetch(
      `${MEILI_URL}/indexes/documents/documents/${encodeURIComponent(id)}`,
      { headers },
    );
    if (r.status === 404) throw new NotFoundException(`document ${id} not found`);
    if (!r.ok) throw new HttpException(`meili ${r.status}`, HttpStatus.BAD_GATEWAY);
    const raw = await r.json() as any;

    // Normalize Meilisearch snake_case fields to the camelCase shape the
    // frontend expects. The indexer flattens authors to a string array
    // (authors_display); re-hydrate them as Author objects.
    // Authors carry snake_case sub-fields from the processor (display_name,
    // orcid, affiliation, badge.has_payments...). COIBadge + the document page
    // read camelCase, so map them here. Fall back to authors_display (names
    // only) when the full objects aren't present.
    const mapBadge = (b: any) => b ? {
      hasPayments: b.hasPayments ?? b.has_payments ?? false,
      totalPaymentsUsd: b.totalPaymentsUsd ?? b.total_payments_usd ?? 0,
      topSponsor: b.topSponsor ?? b.top_sponsor,
      topSponsorAmountUsd: b.topSponsorAmountUsd ?? b.top_sponsor_amount_usd,
      paymentsLastYear: b.paymentsLastYear ?? b.payments_last_year,
      yearsCovered: b.yearsCovered ?? b.years_covered,
    } : undefined;
    const mapAuthor = (a: any) => ({
      displayName: a.displayName ?? a.display_name ?? "",
      orcid: a.orcid,
      affiliation: a.affiliation,
      badge: mapBadge(a.badge),
      payments: a.payments,
    });
    const authors = Array.isArray(raw.authors) && raw.authors.length
      ? raw.authors.map(mapAuthor)
      : ((raw.authors_display as string[] | undefined)?.map((n: string) => ({ displayName: n })) ?? []);

    const doc: any = {
      ...raw,
      canonicalUrl: raw.canonicalUrl ?? raw.canonical_url,
      studyType: raw.studyType ?? raw.study_type,
      publishedAt: raw.publishedAt ?? raw.published_at,
      citationCount: raw.citationCount ?? raw.citation_count,
      nctId: raw.nctId ?? raw.nct_id,
      authors,
    };

    // Best-effort enrich: pull a small citation neighborhood (<=20 nodes)
    // for the result drawer's CitationGraph component. Failures don't
    // block; the drawer falls back gracefully.
    //
    // Meilisearch stores ids with colons replaced by underscores (e.g.
    // "pubmed_42259777") because its primary-key format forbids colons.
    // Neo4j stores the canonical colon form ("pubmed:42259777"). Use
    // canonical_id (written by the meili batcher) to query Neo4j.
    const graphId: string = raw.canonical_id ?? raw.id ?? id;
    try {
      const neighborhood = await fetchNeighborhood(graphId);
      if (neighborhood) {
        // Node ids returned from Neo4j are in colon format. Convert them
        // to underscore format so the frontend can navigate to /document/{id}.
        const toMeili = (s: string) => s.replaceAll(":", "_");
        doc.citationNeighborhood = {
          nodes: (neighborhood as any).nodes.map((n: any) => ({ ...n, id: toMeili(n.id) })),
          edges: (neighborhood as any).edges.map((e: any) => ({
            source: toMeili(e.source),
            target: toMeili(e.target),
          })),
        };
      } else {
        doc.citationNeighborhood = null;
      }
    } catch (err) {
      console.error(`[document] fetchNeighborhood failed for id=${graphId}:`, err);
      doc.citationNeighborhood = null;
    }
    return doc;
  }
}

type NeighborNode = { id: string; title: string; pagerank: number; year: string; dir: 'center'|'out'|'in' };

async function fetchNeighborhood(id: string) {
  if (!id) return null;
  const auth = "Basic " + Buffer.from(
    `${process.env.NEO4J_USER ?? "neo4j"}:${process.env.NEO4J_PASSWORD ?? ""}`,
  ).toString("base64");

  const cypher = {
    statements: [
      {
        // A: center doc + outbound citations (papers this doc cites)
        statement: `
          MATCH (doc:Document {id: $id})
          OPTIONAL MATCH (doc)-[:CITES]->(n:Document)
          RETURN doc.id, doc.title, coalesce(doc.pagerank,0.0), left(coalesce(doc.published_at,''),4),
                 n.id, n.title, coalesce(n.pagerank,0.0), left(coalesce(n.published_at,''),4)
          LIMIT 26`,
        parameters: { id },
      },
      {
        // B: inbound citations (papers that cite this doc)
        statement: `
          MATCH (inc:Document)-[:CITES]->(doc:Document {id: $id})
          RETURN inc.id, inc.title, coalesce(inc.pagerank,0.0), left(coalesce(inc.published_at,''),4)
          LIMIT 15`,
        parameters: { id },
      },
      {
        // C: cross-edges — pairs of outbound neighbours that also cite each other;
        // turns the star into a lattice and reveals shared intellectual lineage.
        statement: `
          MATCH (doc:Document {id: $id})-[:CITES]->(a:Document)-[:CITES]->(b:Document)
          WHERE (doc)-[:CITES]->(b)
          RETURN DISTINCT a.id AS source, b.id AS target
          LIMIT 60`,
        parameters: { id },
      },
    ],
  };

  const r = await fetch(`${NEO4J_HTTP}/db/neo4j/tx/commit`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(cypher),
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) {
    console.error(`[neighborhood] neo4j HTTP ${r.status} for id=${id}`);
    return null;
  }

  const data = await r.json() as any;
  if (data?.errors?.length) {
    console.error(`[neighborhood] neo4j cypher errors for id=${id}:`, JSON.stringify(data.errors));
    return null;
  }
  const rowsA: any[] = data?.results?.[0]?.data ?? [];
  const rowsB: any[] = data?.results?.[1]?.data ?? [];
  const rowsC: any[] = data?.results?.[2]?.data ?? [];
  if (rowsA.length === 0) {
    console.warn(`[neighborhood] document id=${id} not found in Neo4j graph — not yet indexed?`);
    return null;
  }

  const nodeMap = new Map<string, NeighborNode>();
  const edges: { source: string; target: string }[] = [];

  // A — center is always in row[0] (OPTIONAL MATCH guarantees the doc row exists)
  const [dId, dTitle, dPagerank, dYear] = rowsA[0].row as [string, string, number, string];
  nodeMap.set(dId, { id: dId, title: dTitle ?? id, pagerank: dPagerank ?? 0, year: dYear ?? '', dir: 'center' });

  for (const { row } of rowsA) {
    const [,,,, nId, nTitle, nPagerank, nYear] = row as [string,string,number,string, string|null,string|null,number|null,string|null];
    if (nId) {
      if (!nodeMap.has(nId)) nodeMap.set(nId, { id: nId, title: nTitle ?? nId, pagerank: nPagerank ?? 0, year: nYear ?? '', dir: 'out' });
      edges.push({ source: dId, target: nId });
    }
  }

  // B — a node already seen as 'out' keeps that label (it both cites and is cited by this doc)
  for (const { row } of rowsB) {
    const [incId, incTitle, incPagerank, incYear] = row as [string, string, number, string];
    if (!incId) continue;
    if (!nodeMap.has(incId)) nodeMap.set(incId, { id: incId, title: incTitle ?? incId, pagerank: incPagerank ?? 0, year: incYear ?? '', dir: 'in' });
    edges.push({ source: incId, target: dId });
  }

  // C — cross-edges
  for (const { row } of rowsC) {
    const [source, target] = row as [string, string];
    if (source && target) edges.push({ source, target });
  }

  const rest = Array.from(nodeMap.values()).filter(n => n.id !== dId);
  return { nodes: [nodeMap.get(dId)!, ...rest], edges };
}

@Module({ controllers: [DocumentController] })
export class DocumentModule {}
