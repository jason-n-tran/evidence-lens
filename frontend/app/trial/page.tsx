"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// Static-export client page. Reads the trial id from ?id= and fetches the
// gateway in-browser (trials live in the canonical document store as
// "nct:..."/"ictrp:..."). Replaces the old dynamic /trial/[id] server route.
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

function TrialView() {
  const params = useSearchParams();
  const raw = params.get("id") ?? "";
  const docId = raw.startsWith("nct:") || raw.startsWith("ictrp:") ? raw : (raw ? `nct:${raw}` : "");
  const [doc, setDoc] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!docId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${GATEWAY_URL}/api/document/${encodeURIComponent(docId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setDoc(d); })
      .catch(() => { if (!cancelled) setDoc(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [docId]);

  useEffect(() => {
    if (doc?.title) document.title = `${doc.title} · EvidenceLens`;
  }, [doc]);

  if (loading) {
    return <div className="mx-auto max-w-4xl px-4 py-12"><p className="eyebrow animate-pulse">Loading trial…</p></div>;
  }
  if (!doc?.trial) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 space-y-2">
        <h1 className="font-sans text-2xl font-semibold">Trial not found</h1>
        <p className="data text-sm text-[hsl(var(--muted))]">{raw || "(no trial id)"}</p>
      </div>
    );
  }

  const t = doc.trial;
  return (
    <article className="mx-auto max-w-4xl px-4 py-12 space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {t.registry && <span className="tag tag-strong">{t.registry.toUpperCase()}</span>}
          {t.status && <span className="tag">{t.status}</span>}
          {t.phase && <span className="tag">{t.phase}</span>}
          {t.enrollment != null && <span className="eyebrow data">n={t.enrollment}</span>}
        </div>
        <h1 className="font-sans text-3xl font-semibold tracking-tight leading-tight">{doc.title}</h1>
      </header>

      <div className="tick-rule" />

      {doc.abstract && (
        <section aria-labelledby="summary-h">
          <h2 id="summary-h" className="eyebrow mb-2">Summary</h2>
          <p className="evidence whitespace-pre-line leading-relaxed">{doc.abstract}</p>
        </section>
      )}

      <section aria-labelledby="conditions-h" className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h2 id="conditions-h" className="eyebrow mb-2">Conditions</h2>
          <ul className="flex flex-wrap gap-1.5">
            {(t.conditions ?? []).map((c: string) => <li key={c} className="tag">{c}</li>)}
          </ul>
        </div>
        <div>
          <h2 className="eyebrow mb-2">Interventions</h2>
          <ul className="flex flex-wrap gap-1.5">
            {(t.interventions ?? []).map((c: string) => <li key={c} className="tag">{c}</li>)}
          </ul>
        </div>
      </section>

      {t.locations?.length ? (
        <section>
          <h2 className="eyebrow mb-2">Locations</h2>
          <p className="evidence text-sm text-[hsl(var(--muted))]">{t.locations.slice(0, 20).join(" · ")}</p>
        </section>
      ) : null}

      {t.primary_outcome && (
        <section>
          <h2 className="eyebrow mb-2">Primary outcome</h2>
          <p className="evidence text-sm">{t.primary_outcome}</p>
        </section>
      )}

      <p>
        <a className="font-sans text-sm font-medium" href={doc.canonicalUrl} rel="noopener noreferrer" target="_blank">
          Open original on registry ↗
        </a>
      </p>
    </article>
  );
}

export default function TrialPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl px-4 py-8 text-sm text-[hsl(var(--muted))]">Loading…</div>}>
      <TrialView />
    </Suspense>
  );
}
