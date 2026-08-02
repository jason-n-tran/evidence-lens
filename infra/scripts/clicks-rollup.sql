-- Daily clicks rollup. Run nightly at 04:00 by a Dokploy schedule:
--   psql "$DATABASE_URL" -f /scripts/clicks-rollup.sql
--
-- Aggregates yesterday's `clicks` rows into `clicks_daily`. Idempotent:
-- re-running for the same day overwrites the existing rows.

INSERT INTO clicks_daily (day, variant, click_count, unique_sessions, avg_clicked_position)
SELECT
    (server_ts AT TIME ZONE 'UTC')::date AS day,
    COALESCE(variant, '')                AS variant,
    COUNT(*)                             AS click_count,
    COUNT(DISTINCT session_id)           AS unique_sessions,
    AVG(clicked_position)::float8        AS avg_clicked_position
FROM clicks
WHERE server_ts >= (CURRENT_DATE - INTERVAL '1 day')
  AND server_ts <  CURRENT_DATE
GROUP BY 1, 2
ON CONFLICT (day, variant) DO UPDATE SET
    click_count          = EXCLUDED.click_count,
    unique_sessions      = EXCLUDED.unique_sessions,
    avg_clicked_position = EXCLUDED.avg_clicked_position;
