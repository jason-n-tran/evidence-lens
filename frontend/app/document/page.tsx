"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { COIBadge } from "../../components/COIBadge";
import { CitationGraph } from "../../components/CitationGraph";

// Static-export build: this is a client page that reads the document id from the
// query string (/document?id=pubmed:123) and fetches the gateway in-browser.
// Dynamic [id] path segments can't be statically exported with unbounded ids,
// so we use ?id= instead. The gateway is public, so the fetch works client-side.
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

function DocumentView() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const [doc, setDoc] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${GATEWAY_URL}/api/document/${encodeURIComponent(id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setDoc(d); })
      .catch(() => { if (!cancelled) setDoc(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Keep the tab title useful even without server-side metadata.
  useEffect(() => {
    if (doc?.title) document.title = `${doc.title} · EvidenceLens`;
  }, [doc]);

  if (loading) {
    return <div className="mx-auto max-w-4xl px-4 py-8 text-sm text-[hsl(var(--muted))]">Loading…</div>;
  }

  if (!doc) {
    // Either no id, or the document exists only as a Neo4j citation stub (not
    // yet ingested into Meilisearch). Show a helpful page rather than a blank.
    const pmid = id.startsWith("pubmed_") ? id.slice("pubmed_".length)
               : id.startsWith("pubmed:") ? id.slice("pubmed:".length) : null;
    return (
      <article className="mx-auto max-w-4xl px-4 py-8 space-y-4">
        <h1 className="text-2xl font-semibold">Document not yet indexed</h1>
        <p className="text-sm text-[hsl(var(--muted))]">{id || "(no document id)"}</p>
        <p>
          This document appears in citation graphs because another indexed paper references it,
          but it hasn&apos;t been ingested into EvidenceLens yet.
        </p>
        {pmid && (
          <p>
            <a className="underline" href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
               rel="noopener noreferrer" target="_blank">
              View on PubMed ↗
            </a>
          </p>
        )}
      </article>
    );
  }

  // JSON-LD: ScholarlyArticle with author + journal + COI annotations.
  const schemaType = doc.studyType === "TRIAL_REGISTRY" ? "MedicalStudy" : "ScholarlyArticle";
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": schemaType,
    headline: doc.title,
    name: doc.title,
    description: (doc.abstract ?? "").slice(0, 600),
    url: doc.canonicalUrl,
    identifier: [
      ...(doc.doi   ? [{ "@type": "PropertyValue", name: "doi",   value: doc.doi }] : []),
      ...(doc.pmid  ? [{ "@type": "PropertyValue", name: "pmid",  value: doc.pmid }] : []),
      ...(doc.pmcid ? [{ "@type": "PropertyValue", name: "pmcid", value: doc.pmcid }] : []),
      ...(doc.nctId ? [{ "@type": "PropertyValue", name: "nct",   value: doc.nctId }] : []),
    ],
    datePublished: doc.publishedAt,
    license: doc.license,
    citation: doc.citationCount,
    author: (doc.authors ?? []).map((a: any) => ({
      "@type": "Person",
      name: a.displayName,
      ...(a.orcid ? { identifier: a.orcid } : {}),
      ...(a.affiliation ? { affiliation: a.affiliation } : {}),
    })),
    isPartOf: doc.journal ? { "@type": "Periodical", name: doc.journal.name, issn: doc.journal.issn } : undefined,
  };

  return (
    <article className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {doc.studyType && <span className="tag tag-strong">{String(doc.studyType).replaceAll("_", " ")}</span>}
          <span className="eyebrow">
            {[doc.journal?.name, doc.publishedAt?.slice(0, 10)].filter(Boolean).join(" · ")}
          </span>
        </div>
        <h1 className="font-sans text-3xl font-semibold tracking-tight leading-tight">{doc.title}</h1>
      </header>

      {doc.salience && (
        <p role="note" className="evidence rounded-r border-l-2 border-[hsl(var(--accent-bright))] bg-[hsl(var(--accent)/0.05)] p-3 text-sm">
          {doc.salience}
        </p>
      )}

      <div className="tick-rule" />

      <section aria-labelledby="authors-h">
        <h2 id="authors-h" className="eyebrow mb-3">Authors · conflicts of interest</h2>
        <ul className="space-y-1.5">
          {doc.authors?.map((a: any, i: number) => (
            <li key={i} className="flex items-center gap-1">
              <span>{a.displayName}</span>
              <COIBadge author={a} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="abstract-h">
        <h2 id="abstract-h" className="eyebrow mb-2">Abstract</h2>
        <p className="evidence whitespace-pre-line leading-relaxed">{doc.abstract}</p>
      </section>

      <section aria-labelledby="cite-h">
        <h2 id="cite-h" className="eyebrow mb-2">Citation neighborhood</h2>
        <CitationGraph initialGraphData={doc.citationNeighborhood} />
      </section>

      <p>
        <a className="font-sans text-sm font-medium" href={doc.canonicalUrl} rel="noopener noreferrer" target="_blank">
          Open original at source ↗
        </a>
      </p>
    </article>
  );
}

export default function DocumentPage() {
  // useSearchParams requires a Suspense boundary in the static export build.
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl px-4 py-8 text-sm text-[hsl(var(--muted))]">Loading…</div>}>
      <DocumentView />
    </Suspense>
  );
}
