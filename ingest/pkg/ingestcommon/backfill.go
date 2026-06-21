package ingestcommon

import "time"

// Backfill support for date-windowed ingesters.
//
// THE PROBLEM this solves: each ingester queries [hwm, today], paginates until
// it hits MaxPerRun, then sets the watermark to TODAY. If the window held more
// than MaxPerRun docs, everything between the last-fetched doc and today is
// silently skipped — so the corpus only ever has a thin recent slice and no
// history. (See e.g. nsf.go: `if Fetched > 0 { newHWM = to }`.)
//
// THE FIX: when backfill mode is on AND the run filled MaxPerRun (the window
// wasn't exhausted), advance the watermark to the LATEST item date actually
// seen this run — not to today. The next run resumes from there and marches
// forward through history, MaxPerRun docs at a time, with no gap. Once a run
// comes back UNDER the cap, the window is exhausted and we advance to today
// (caught up → normal incremental mode resumes).
//
// Enable with BACKFILL=1. Seed the starting point on the very first run with
// BACKFILL_SINCE=<date> (in the source's own date format), e.g.
//   BACKFILL=1 BACKFILL_SINCE=2015-01-01
// Without BACKFILL_SINCE the existing cold-start lookback is used.

// BackfillEnabled reports whether backfill (history-march) mode is on.
func BackfillEnabled() bool {
	v := GetEnv("BACKFILL", "")
	return v == "1" || v == "true" || v == "yes"
}

// BackfillSince returns the configured backfill start date (raw string, in the
// source's own format), or "" if unset. Callers use it to seed the cold-start
// watermark so the first backfill run starts deep in history.
func BackfillSince() string {
	return GetEnv("BACKFILL_SINCE", "")
}

// NextWatermark computes the watermark to persist after a run.
//
//	prevHWM    the window start this run used
//	today      the value normally written when caught up (usually time.Now()
//	           formatted in the source's date format)
//	fetched    docs fetched this run
//	maxPerRun  the run cap
//	latestSeen the latest item date observed this run, in the SAME format as
//	           today/prevHWM ("" if the source can't cheaply track it)
//
// Rules:
//   - fetched == 0            -> keep prevHWM (don't advance past an empty window)
//   - backfill + hit the cap  -> advance to latestSeen (resume mid-history next
//                                run); fall back to prevHWM if latestSeen is ""
//     so we never jump to today and skip the gap
//   - otherwise               -> advance to today (caught up / normal mode)
func NextWatermark(prevHWM, today string, fetched, maxPerRun int, latestSeen string) string {
	if fetched == 0 {
		return prevHWM
	}
	if BackfillEnabled() && maxPerRun > 0 && fetched >= maxPerRun {
		if latestSeen != "" {
			return latestSeen
		}
		return prevHWM // can't resume precisely; re-run the same window rather than skip
	}
	return today
}

// MaxDate keeps a running maximum of date strings that sort lexicographically in
// chronological order (true for ISO YYYY-MM-DD and YYYY/MM/DD). Returns the
// later of a, b. For formats that DON'T sort chronologically (e.g. NSF's
// MM/DD/YYYY) the caller must convert before comparing, or pass "" to skip.
func MaxDate(a, b string) string {
	if b > a {
		return b
	}
	return a
}

// ParseAdvance is a tiny helper for sources whose item dates need parsing: given
// a layout and two date strings, return the later one formatted back in layout.
// Unparseable inputs are treated as "older" so a good value always wins.
func ParseAdvance(layout, a, b string) string {
	ta, ea := time.Parse(layout, a)
	tb, eb := time.Parse(layout, b)
	switch {
	case ea != nil && eb != nil:
		return a
	case ea != nil:
		return b
	case eb != nil:
		return a
	case tb.After(ta):
		return b
	default:
		return a
	}
}
