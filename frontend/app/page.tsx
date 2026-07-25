import Link from "next/link";
import { SearchInput } from "../components/SearchInput";
import { RecallTicker } from "../components/RecallTicker";

const SOURCES = ["PubMed", "Preprints", "Trials", "FDA / EMA", "Open Payments"];

export default function Home() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:py-24">
      <header className="text-center">
        <p className="eyebrow mb-5">Biomedical evidence · with the conflicts in view</p>

        <h1 className="font-sans text-5xl sm:text-6xl font-semibold tracking-tight inline-flex items-baseline gap-px">
          Evidence
          <span className="relative text-[hsl(var(--accent))]">
            Lens
            <span
              aria-hidden="true"
              className="focal-dot absolute -right-3 top-1 h-2 w-2 rounded-full bg-[hsl(var(--accent-bright))]"
            />
          </span>
        </h1>

        <p className="mt-4 evidence text-lg text-[hsl(var(--muted))]">
          Search papers, trials, and recalls — then see who paid the authors.
        </p>
      </header>

      <div className="mt-10">
        <SearchInput
          placeholder="try 'sglt2 inhibitors heart failure'"
          autoFocus
        />
        <p className="eyebrow mt-3 text-center">
          Press <span className="text-[hsl(var(--accent))]">/</span> to focus · streamed result waves · COI badges on every author
        </p>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        {SOURCES.map((s) => (
          <span key={s} className="tag">{s}</span>
        ))}
      </div>

      <div className="tick-rule my-12" />

      <RecallTicker />

      <nav
        aria-label="Top-level"
        className="mt-12 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm font-sans"
      >
        <Link href="/about" className="text-[hsl(var(--muted))] hover:text-[hsl(var(--accent))]">About</Link>
        <Link href="/recalls" className="text-[hsl(var(--muted))] hover:text-[hsl(var(--accent))]">Recent recalls</Link>
        <Link href="/docs" className="text-[hsl(var(--muted))] hover:text-[hsl(var(--accent))]">Docs</Link>
        <Link href="/licenses" className="text-[hsl(var(--muted))] hover:text-[hsl(var(--accent))]">Licenses</Link>
        <Link href="/changelog" className="text-[hsl(var(--muted))] hover:text-[hsl(var(--accent))]">Changelog</Link>
      </nav>
    </div>
  );
}
