import Link from "next/link";

type Source = { name: string; license: string };
type Group = { tier: string; note?: string; sources: Source[] };

// Grouped by ingestion tier. License terms mirror docs/sources/*.md; full
// per-source attribution and terms live there.
const GROUPS: Group[] = [
  {
    tier: "Literature",
    sources: [
      { name: "PubMed", license: "Public domain (NLM)" },
      { name: "Europe PMC", license: "Per record" },
      { name: "PMC Open Access", license: "CC-BY / CC0 (per article)" },
      { name: "bioRxiv", license: "CC-BY (per preprint)" },
      { name: "medRxiv", license: "CC-BY-NC-ND (per preprint, default)" },
      { name: "OpenAlex", license: "CC0" },
      { name: "CrossRef", license: "Public" },
      { name: "Semantic Scholar", license: "ODC-BY" },
      { name: "Unpaywall", license: "CC0" },
      { name: "CORE", license: "Per record" },
      { name: "Cochrane", license: "Per review — academic only, metadata + abstract" },
    ],
  },
  {
    tier: "Trials",
    sources: [
      { name: "ClinicalTrials.gov v2", license: "Public domain" },
      { name: "WHO ICTRP", license: "Per source registry" },
    ],
  },
  {
    tier: "Regulatory & safety",
    sources: [
      { name: "openFDA (drug + device)", license: "Public domain" },
      { name: "EMA", license: "Public" },
      { name: "MHRA (UK)", license: "OGL UK" },
      { name: "Health Canada", license: "Open Government Licence — Canada" },
      { name: "TGA (Australia)", license: "CC-BY" },
      { name: "PMDA (Japan)", license: "Per source" },
      { name: "CDC WONDER", license: "Public domain" },
    ],
  },
  {
    tier: "Guidelines",
    sources: [{ name: "USPSTF · AHRQ · NICE", license: "Public (US) / OGL UK (NICE)" }],
  },
  {
    tier: "Funding & conflicts",
    sources: [
      { name: "CMS Open Payments", license: "Public domain" },
      { name: "NIH RePORTER", license: "Public" },
      { name: "NSF Awards", license: "Public domain" },
    ],
  },
  {
    tier: "Biomedical knowledge",
    note: "Used for entity linking and enrichment, not served as primary documents.",
    sources: [
      { name: "ChEMBL", license: "CC-BY-SA" },
      { name: "DrugBank", license: "CC-BY-NC (open data subset)" },
      { name: "OMIM", license: "Restricted — registration required" },
      { name: "HPO", license: "Custom open (HPO)" },
      { name: "DisGeNET", license: "CC-BY-NC-SA" },
      { name: "ClinVar", license: "Public domain" },
    ],
  },
];

export default function LicensesPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <p className="eyebrow mb-2">Licensing</p>
      <h1 className="font-sans text-3xl font-semibold tracking-tight">Licenses &amp; attribution</h1>
      <p className="evidence mt-3 text-[hsl(var(--muted))]">
        EvidenceLens itself is <strong className="text-[hsl(var(--ink))]">MIT</strong>. Each upstream
        source keeps its own terms — we respect the most restrictive applicable license per record,
        and never serve full text where a source forbids it. Where a license is per-record, the
        document page links back to the original so you can check its specific terms.
      </p>

      <div className="tick-rule my-8" />

      <div className="space-y-8">
        {GROUPS.map((g) => (
          <section key={g.tier}>
            <h2 className="eyebrow mb-1">{g.tier}</h2>
            {g.note && <p className="text-xs text-[hsl(var(--muted))] mb-2">{g.note}</p>}
            <ul className="divide-y divide-[hsl(var(--rule))]">
              {g.sources.map((s) => (
                <li key={s.name} className="flex items-baseline justify-between gap-4 py-1.5">
                  <span className="font-sans text-sm">{s.name}</span>
                  <span className="tag shrink-0">{s.license}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="tick-rule my-8" />

      <p className="text-sm text-[hsl(var(--muted))]">
        Full per-source attribution and terms live in{" "}
        <a href="https://github.com/evidencelens/evidencelens/tree/main/docs/sources">docs/sources/</a>.
        Spot a licensing error?{" "}
        <a href="https://github.com/evidencelens/evidencelens/issues">Open an issue</a>.{" "}
        <Link href="/docs">Back to docs</Link>.
      </p>
    </div>
  );
}
