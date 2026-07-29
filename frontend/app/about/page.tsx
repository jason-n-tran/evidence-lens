export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-8 space-y-4 prose">
      <h1>About EvidenceLens</h1>
      <p>
        EvidenceLens is a free, public, agentic biomedical evidence search engine. It unifies PubMed,
        preprints, clinical trials, FDA / EMA regulatory data, conflict-of-interest records, and funding
        sources behind a hybrid (BM25 + vector + citation + recency) ranker. Every result shows COI
        badges next to author names.
      </p>
      <p>
        It is <strong>not medical advice</strong>. Always verify against primary sources and consult a
        clinician for any health decision.
      </p>
      <p>
        The project is open source (MIT). Source: <a href="https://github.com/evidencelens/evidencelens">github.com/evidencelens/evidencelens</a>.
        Total recurring cost is $0 — we run on free tiers and the maintainer's existing hardware.
      </p>
    </article>
  );
}
