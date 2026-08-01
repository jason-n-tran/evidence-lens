/**
 * Sentry client init (spec §10.5).
 *
 * Session Replay enabled at low sample rate (10% normal, 100% on
 * errors) to keep Sentry free-tier event volume sustainable.
 * Performance traces sampled at 10%.
 */
import * as Sentry from "@sentry/nextjs";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (DSN) {
  Sentry.init({
    dsn: DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,        // BYOK keys could appear; mask everything.
        blockAllMedia: true,
        networkDetailAllowUrls: [],   // never capture request bodies
      }),
    ],
    // Breadcrumbs for user-facing flows.
    beforeBreadcrumb(b) {
      // Drop fetch breadcrumbs to /llm/* — body could contain key-shaped string.
      if (b.category === "fetch" && (b.data as any)?.url?.includes("/llm/")) {
        return null;
      }
      return b;
    },
    // Hard scrub of any URL or body that looks like a Bearer token.
    beforeSend(ev) {
      const json = JSON.stringify(ev);
      if (/Bearer\s+[A-Za-z0-9-_.]{20,}/.test(json)) {
        return null;
      }
      return ev;
    },
  });
}
