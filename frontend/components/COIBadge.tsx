"use client";

import { useState } from "react";

interface Author {
  displayName: string;
  badge?: {
    hasPayments: boolean;
    totalPaymentsUsd: number;
    topSponsor?: string;
    topSponsorAmountUsd?: number;
    paymentsLastYear?: number;
    yearsCovered?: string[];
  };
  payments?: any[];
}

/**
 * Flagship component. Renders next to author names. Click/hover reveals
 * a tooltip with sponsor + amount detail. Conservative rendering: when
 * `hasPayments` is false (no Open Payments match above threshold), we
 * render nothing — never a "no payments" badge, since absence of match
 * is not absence of conflicts.
 */
// Exposure on a log scale: $100 reads as a sliver, $1M+ fills the gauge.
// Absolute dollars span ~5 orders of magnitude, so linear would flatten almost
// everything to zero — log keeps small and large conflicts both legible.
function exposure(usd: number): number {
  if (usd <= 0) return 0;
  const pct = (Math.log10(usd) - 2) / 4; // $100 → 0, $1,000,000 → 1
  return Math.max(0.06, Math.min(1, pct));
}

export function COIBadge({ author }: { author: Author }) {
  const [open, setOpen] = useState(false);
  const b = author.badge;
  if (!b?.hasPayments) return null;
  const fmt = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const fill = Math.round(exposure(b.totalPaymentsUsd) * 100);

  return (
    <span className="relative inline-flex items-center align-middle ml-1.5">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Conflict of interest for ${author.displayName}: ${fmt(b.totalPaymentsUsd)} from ${b.topSponsor}`}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded border border-[hsl(var(--coi)/0.4)] bg-[hsl(var(--coi)/0.07)] px-1.5 py-0.5"
      >
        <span className="gauge" aria-hidden="true"><i style={{ width: `${fill}%` }} /></span>
        <span className="coi-readout">{fmt(b.totalPaymentsUsd)}</span>
      </button>
      {open && (
        <span
          role="tooltip"
          className="panel absolute left-0 top-full mt-1.5 z-50 w-72 p-3 text-sm shadow-lg"
        >
          <strong className="block font-sans">{author.displayName}</strong>
          <span className="mt-1.5 block">
            <span className="gauge" aria-hidden="true" style={{ width: 88 }}>
              <i style={{ width: `${fill}%` }} />
            </span>
          </span>
          <span className="mt-1.5 block text-[hsl(var(--muted))]">
            <span className="coi-readout text-[0.8rem]">{fmt(b.totalPaymentsUsd)}</span> total
            {b.topSponsor ? <> · top sponsor {b.topSponsor} {b.topSponsorAmountUsd ? fmt(b.topSponsorAmountUsd) : ""}</> : null}
          </span>
          {b.yearsCovered?.length ? (
            <span className="eyebrow mt-2 block">Years {b.yearsCovered.join(", ")}</span>
          ) : null}
          <span className="mt-2 block text-xs text-[hsl(var(--muted))]">
            CMS Open Payments · fuzzy match ≥0.90 confidence.
          </span>
        </span>
      )}
    </span>
  );
}
