export function DisclaimerBanner() {
  return (
    <div role="region" aria-label="Disclaimer" className="status-bar text-xs">
      <p className="mx-auto max-w-7xl px-4 py-2 flex items-center gap-2">
        <span aria-hidden="true" className="focal-dot inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent-bright))]" />
        EvidenceLens is a research tool — <strong>not medical advice</strong>.
        COI badges are computed from public records via fuzzy matching and may contain false positives.
        Always verify against primary sources.
      </p>
    </div>
  );
}
