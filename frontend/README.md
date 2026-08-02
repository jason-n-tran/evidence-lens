# frontend

Next.js 15 App Router (React 19, TypeScript, Tailwind 4) on Cloudflare Pages.

## Routes (per spec §8)

`/`, `/search`, `/document/[id]`, `/trial/[id]`, `/recalls`, `/about`, `/docs/*`, `/licenses`, `/changelog`.

## Components

- **SearchInput** with `/` keyboard shortcut and ARIA labels.
- **ResultsStream** — WebSocket-streamed waves, ARIA live region, j/k/Esc keyboard nav.
- **ResultCard** — title + journal + study type + author chips with COI badges.
- **COIBadge** (flagship) — hover/focus tooltip with sponsor totals + years; never rendered when no match (absence ≠ no conflicts).
- **FacetSidebar** — study type, year range, quality toggles.
- **TierPicker** + **ByokKeyManager** + **WebLLMSetup** — three-tier inference UI. Key stored in localStorage only.
- **RecallTicker** — last 7 days of recalls.
- **CitationGraph** — d3-force citation viz (seed node highlighted, radius scales with degree).
- **DisclaimerBanner**, **SkipNav** — a11y baseline.

## Performance

Lighthouse CI (`.lighthouserc.json`) gates: LCP ≤ 2s, TTI ≤ 3s, total bytes ≤ 200KB. Per spec §8.6.

## Accessibility

axe-core via Playwright (`tests/a11y/axe.spec.ts`) — zero violations across `/`, `/search`, `/recalls`, `/about`, `/licenses`. WCAG 2.2 AA.

## State

[Zustand](https://github.com/pmndrs/zustand) — search filters in memory, BYOK state persisted to `localStorage` with key `evidencelens-byok`.

## Run

```bash
npm install                                  # at the repo root
npm run dev --workspace frontend             # http://localhost:3000
npm run test:a11y --workspace frontend       # axe + Playwright
npm run lighthouse --workspace frontend      # gates
```

## Env

`NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_WEBLLM_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`.
