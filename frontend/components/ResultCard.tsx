"use client";

import Link from "next/link";
import { forwardRef } from "react";
import { COIBadge } from "./COIBadge";

interface Props { result: any; focused?: boolean; onSelect?: () => void }

export const ResultCard = forwardRef<HTMLLIElement, Props>(function ResultCard({ result, focused, onSelect }, ref) {
  const d = result.document;
  const url = `/document?id=${encodeURIComponent(d.id)}`;
  const source = d.journal?.name ?? d.source;
  const year = d.publishedAt?.slice(0, 4) ?? d.published_at?.slice(0, 4);
  const studyType = d.studyType ?? d.study_type;
  const cites = d.citationCount ?? d.citation_count;
  return (
    <li
      ref={ref}
      tabIndex={0}
      aria-current={focused ? "true" : undefined}
      className="specimen p-4 focus:outline-none"
    >
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        {studyType && (
          <span className="tag tag-strong">{String(studyType).replaceAll("_", " ")}</span>
        )}
        <span className="eyebrow truncate">
          {[source, year].filter(Boolean).join(" · ")}
        </span>
        {typeof cites === "number" && cites > 0 && (
          <span className="eyebrow ml-auto data">{cites} cites</span>
        )}
      </div>

      <Link href={url as any} className="block font-sans text-[1.05rem] font-medium leading-snug text-[hsl(var(--ink))] hover:text-[hsl(var(--accent))]" onClick={onSelect}>
        {d.title || <span className="text-[hsl(var(--muted))]">[Untitled]</span>}
      </Link>

      {d.salience && (
        <p className="text-xs text-[hsl(var(--accent))] mt-1.5">{d.salience}</p>
      )}

      {d.authors?.length ? (
        <div className="text-sm mt-2 flex flex-wrap items-center gap-x-1 gap-y-1.5">
          {d.authors.slice(0, 6).map((a: any, i: number) => (
            <span key={i} className="inline-flex items-center">
              {a.displayName}<COIBadge author={a} />{i < Math.min(5, d.authors.length - 1) ? <span className="text-[hsl(var(--muted))]">,</span> : ""}
            </span>
          ))}
          {d.authors.length > 6 && <span className="text-[hsl(var(--muted))]">…</span>}
        </div>
      ) : null}

      {d.abstract && <p className="evidence text-sm mt-2.5 line-clamp-3 text-[hsl(var(--muted))]">{d.abstract}</p>}
    </li>
  );
});
