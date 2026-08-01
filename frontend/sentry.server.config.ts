/**
 * Sentry server init — fatal-only (spec §10.5). The bulk of server
 * observability flows through OTel; Sentry catches uncaught throws.
 */
import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
if (DSN) {
  Sentry.init({
    dsn: DSN,
    tracesSampleRate: 0.0,
    sampleRate: 1.0,
    beforeSend(ev) {
      // Only fatal-level server events.
      if (ev.level && ev.level !== "fatal" && ev.level !== "error") return null;
      return ev;
    },
  });
}
